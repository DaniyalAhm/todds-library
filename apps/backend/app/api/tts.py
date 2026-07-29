from __future__ import annotations

from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.dependencies import get_current_user, get_db
from app.models.user import User
from app.services.book_service import get_book_for_user
from app.services.tts_service import (
    TTSError,
    list_available_voices,
    synthesize,
    clone_voice,
    delete_cloned_voice,
)

router = APIRouter()


class SynthesizeRequest(BaseModel):
    text: str
    voice: str | None = None


class VoiceInfo(BaseModel):
    id: str
    name: str
    language: str
    is_cloned: bool


class CloneVoiceResponse(BaseModel):
    voice_id: str
    name: str


@router.get("/tts/voices", response_model=list[VoiceInfo])
async def get_voices():
    return list_available_voices()


@router.post("/tts/voices/clone", response_model=CloneVoiceResponse, status_code=status.HTTP_201_CREATED)
async def create_cloned_voice(
    name: str = Form(...),
    audio: UploadFile = File(...),
    current_user: User = Depends(get_current_user),
):
    if not audio.content_type or not audio.content_type.startswith("audio/"):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="File must be an audio file")

    audio_bytes = await audio.read()
    if len(audio_bytes) == 0:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Audio file is empty")

    try:
        voice_id = clone_voice(name, audio_bytes)
    except TTSError as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

    return CloneVoiceResponse(voice_id=voice_id, name=name)


@router.delete("/tts/voices/{voice_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_cloned_voice(
    voice_id: str,
    current_user: User = Depends(get_current_user),
):
    try:
        delete_cloned_voice(voice_id)
    except TTSError as e:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(e))


@router.post("/books/{book_id}/tts/synthesize")
async def synthesize_speech(
    book_id: UUID,
    req: SynthesizeRequest,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    book = await get_book_for_user(db, book_id, current_user.id)
    if book is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Book not found")

    if not req.text.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Text is required")

    try:
        audio_data = await synthesize(req.text, req.voice)
    except TTSError as e:
        raise HTTPException(status_code=status.HTTP_500_INTERNAL_SERVER_ERROR, detail=str(e))

    from fastapi.responses import Response

    return Response(
        content=audio_data,
        media_type="audio/wav",
        headers={"Content-Disposition": 'inline; filename="tts.waw"'},
    )
