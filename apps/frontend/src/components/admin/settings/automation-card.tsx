'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { SettingField } from '@/components/settings/setting-field';
import { SettingSelect } from '@/components/settings/setting-select';
import { GEN_MODE_OPTIONS, LANGUAGE_OPTIONS } from './constants';
import { Wand2 } from 'lucide-react';

interface AutomationCardProps {
  subtitleGenMode: string;
  autoGenLanguage: string;
  chapterGapThreshold: string;
  onChange: (key: 'subtitle_gen_mode' | 'auto_gen_language' | 'chapter_gap_threshold_sec', value: string) => void;
}

export function AutomationCard({ subtitleGenMode, autoGenLanguage, chapterGapThreshold, onChange }: AutomationCardProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Wand2 className="h-5 w-5 text-primary" />
          <CardTitle>Automation</CardTitle>
        </div>
        <CardDescription>When subtitles and chapters are generated during library scans.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <SettingField label="Subtitle Generation Mode" description="Controls when subtitles are automatically generated during library scans.">
          <SettingSelect value={subtitleGenMode} onChange={(v) => onChange('subtitle_gen_mode', v)} options={GEN_MODE_OPTIONS} ariaLabel="Subtitle Generation Mode" />
        </SettingField>
        <SettingField label="Auto-Generation Language" description="Language hint for auto-generated subtitles. Auto-detect works well for most cases.">
          <SettingSelect value={autoGenLanguage} onChange={(v) => onChange('auto_gen_language', v)} options={LANGUAGE_OPTIONS} ariaLabel="Auto-Generation Language" />
        </SettingField>
        <SettingField label="Chapter Gap Threshold (seconds)" description="A silence gap of at least this long between whisper segments marks a chapter boundary.">
          <Input type="number" min={0.1} step={0.5} value={chapterGapThreshold} onChange={(e) => onChange('chapter_gap_threshold_sec', e.target.value)} />
        </SettingField>
      </CardContent>
    </Card>
  );
}
