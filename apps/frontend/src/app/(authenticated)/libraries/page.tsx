'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useAuth } from '@/hooks/use-auth';
import { useLibraries, useDeleteLibrary, useScanLibrary } from '@/hooks/use-libraries';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { AddLibraryDialog } from '@/components/libraries/add-library-dialog';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Scan, Trash2, Library, ExternalLink, FolderOpen } from 'lucide-react';

export default function LibrariesPage() {
  const { user } = useAuth();
  const { data: libraries, isLoading, error } = useLibraries();
  const deleteLibrary = useDeleteLibrary();
  const scanLibrary = useScanLibrary();
  const isAdmin = Boolean(user?.isAdmin);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);

  const handleDelete = async (id: string) => {
    await deleteLibrary.mutateAsync(id);
    setDeleteConfirmId(null);
  };

  const handleScan = async (id: string) => {
    await scanLibrary.mutateAsync(id);
  };

  if (error) {
    return (
      <div className="text-center py-12">
        <p className="text-destructive">Failed to load libraries</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground sm:text-3xl">Libraries</h1>
          <p className="mt-1 text-muted-foreground">
            Manage your media library folders
          </p>
        </div>
        {isAdmin && (
          <AddLibraryDialog />
        )}
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-40 rounded-lg" />
          ))}
        </div>
      ) : libraries && libraries.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {libraries.map((lib) => (
            <Card key={lib.id} className="min-w-0">
              <CardHeader className="pb-3">
                <div className="flex min-w-0 items-start justify-between">
                  <div className="flex min-w-0 items-center gap-2">
                    <Library className="h-5 w-5 shrink-0 text-primary" />
                    <div className="min-w-0">
                      <CardTitle className="text-lg">{lib.name}</CardTitle>
                      <CardDescription className="mt-1 break-all font-mono text-xs">
                        {lib.path}
                      </CardDescription>
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  <Badge variant="secondary">{lib.type}</Badge>
                  <span className="text-sm text-muted-foreground">
                    {lib.book_count} books
                  </span>
                </div>
                <div className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:items-center">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleScan(lib.id)}
                    disabled={!isAdmin || scanLibrary.isPending}
                  >
                    <Scan className="mr-1 h-4 w-4" />
                    Scan
                  </Button>
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/libraries/${lib.id}`}>
                      <ExternalLink className="mr-1 h-4 w-4" />
                      Browse
                    </Link>
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive sm:ml-auto"
                    onClick={() => setDeleteConfirmId(lib.id)}
                    disabled={!isAdmin}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center rounded-lg border border-border bg-card p-12 text-center">
          <Library className="h-12 w-12 text-muted-foreground/50" />
          <h3 className="mt-4 text-lg font-semibold">No libraries yet</h3>
          <p className="mt-2 text-sm text-muted-foreground">
            {isAdmin ? 'Add your first directory to start scanning books.' : 'No media directories have been added yet.'}
          </p>
          {isAdmin && (
            <AddLibraryDialog
              trigger={(
                <Button className="mt-4">
                  <FolderOpen className="mr-2 h-4 w-4" />
                  Add Directory
                </Button>
              )}
            />
          )}
        </div>
      )}

      <Dialog open={!!deleteConfirmId} onOpenChange={(o) => !o && setDeleteConfirmId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Library</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this library? Books will not be
              deleted from disk.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirmId(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirmId && handleDelete(deleteConfirmId)}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
