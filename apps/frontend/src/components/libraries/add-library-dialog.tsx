'use client';

import { useState } from 'react';
import { ChevronLeft, FolderOpen, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useCreateLibrary, useLibraryDirectories } from '@/hooks/use-libraries';

type LibraryKind = 'ebook' | 'audiobook' | 'mixed';

interface AddLibraryDialogProps {
  trigger?: React.ReactNode;
}

export function AddLibraryDialog({ trigger }: AddLibraryDialogProps) {
  const createLibrary = useCreateLibrary();
  const [open, setOpen] = useState(false);
  const [browserPath, setBrowserPath] = useState<string | undefined>();
  const [addType, setAddType] = useState<LibraryKind>('mixed');
  const [newLibrary, setNewLibrary] = useState({ name: '', path: '', type: 'mixed' as LibraryKind });
  const [createError, setCreateError] = useState('');
  const {
    data: directories,
    isLoading: directoriesLoading,
    error: directoriesError,
  } = useLibraryDirectories(open, browserPath);

  const reset = () => {
    setBrowserPath(undefined);
    setAddType('mixed');
    setNewLibrary({ name: '', path: '', type: 'mixed' });
    setCreateError('');
  };

  const addLibrary = async (library: { name: string; path: string; type: LibraryKind }) => {
    setCreateError('');
    try {
      await createLibrary.mutateAsync(library);
      reset();
      setOpen(false);
    } catch (err) {
      const message = err && typeof err === 'object' && 'message' in err
        ? String(err.message)
        : 'Failed to add library';
      setCreateError(message);
    }
  };

  const addCurrentDirectory = () => {
    const path = directories?.current || '';
    const name = path.split('/').filter(Boolean).pop() || 'Books';
    void addLibrary({ name, path, type: addType });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (!nextOpen) {
          reset();
        }
      }}
    >
      <DialogTrigger asChild>
        {trigger || (
          <Button>
            <Plus className="mr-2 h-4 w-4" />
            Add Library
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-1rem)] max-w-3xl overflow-y-auto p-4 sm:p-6">
        <DialogHeader>
          <DialogTitle>Add Library</DialogTitle>
          <DialogDescription>
            Browse to the directory containing your books, then add it as a library. The scanner will find all ebook and audiobook files recursively.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div>
            <div className="flex items-center justify-between gap-3">
              <label className="text-sm font-medium">Directory</label>
              {directories?.parent && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setBrowserPath(directories.parent || undefined)}
                >
                  <ChevronLeft className="mr-1 h-4 w-4" />
                  Up
                </Button>
              )}
            </div>
            <div className="mt-2 rounded-md border border-border">
              <div className="flex flex-col gap-3 border-b border-border p-3 sm:flex-row sm:items-end sm:justify-between">
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {directories?.current || '/books'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Select
                    value={addType}
                    onValueChange={(value) => setAddType(value as LibraryKind)}
                  >
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="mixed">Mixed</SelectItem>
                      <SelectItem value="ebook">Ebooks</SelectItem>
                      <SelectItem value="audiobook">Audiobooks</SelectItem>
                    </SelectContent>
                  </Select>
                  <Button
                    type="button"
                    size="sm"
                    disabled={!directories?.current || createLibrary.isPending}
                    onClick={addCurrentDirectory}
                  >
                    <Plus className="mr-1 h-4 w-4" />
                    Add Library
                  </Button>
                </div>
              </div>
              <div className="max-h-[40dvh] overflow-y-auto p-1 sm:max-h-56">
                {directoriesLoading ? (
                  <div className="p-3 text-sm text-muted-foreground">Loading directories</div>
                ) : directoriesError ? (
                  <div className="p-3 text-sm text-destructive">Failed to load directories</div>
                ) : directories?.items.length ? (
                  directories.items.map((directory) => (
                    <div
                      key={directory.path}
                      className="flex items-center justify-between rounded-sm px-3 py-2 hover:bg-accent"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">{directory.name}</p>
                          <p className="truncate font-mono text-xs text-muted-foreground">{directory.path}</p>
                        </div>
                      </div>
                      {directory.has_children && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => setBrowserPath(directory.path)}
                        >
                          Open
                        </Button>
                      )}
                    </div>
                  ))
                ) : (
                  <div className="p-3 text-sm text-muted-foreground">No child directories</div>
                )}
              </div>
            </div>
          </div>
          <div>
            <label className="text-sm font-medium">Manual Name</label>
            <Input
              placeholder="My Books"
              value={newLibrary.name}
              onChange={(event) => setNewLibrary({ ...newLibrary, name: event.target.value })}
            />
          </div>
          <div>
            <label className="text-sm font-medium">Manual Path</label>
            <Input
              placeholder="/books"
              value={newLibrary.path}
              onChange={(event) => setNewLibrary({ ...newLibrary, path: event.target.value })}
            />
          </div>
          <div>
            <label className="text-sm font-medium">Manual Type</label>
            <Select
              value={newLibrary.type}
              onValueChange={(value) => setNewLibrary({ ...newLibrary, type: value as LibraryKind })}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mixed">Mixed</SelectItem>
                <SelectItem value="ebook">Ebooks</SelectItem>
                <SelectItem value="audiobook">Audiobooks</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {createError && (
            <p className="text-sm text-destructive">{createError}</p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            className="mt-2 sm:mt-0"
            onClick={() => {
              reset();
              setOpen(false);
            }}
          >
            Cancel
          </Button>
          <Button
            className="w-full sm:w-auto"
            onClick={() => void addLibrary(newLibrary)}
            disabled={!newLibrary.name || !newLibrary.path || createLibrary.isPending}
          >
            Add Manual Library
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
