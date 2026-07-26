'use client';

import Link from 'next/link';
import { useLibraries, useScanLibrary } from '@/hooks/use-libraries';
import { useBooks } from '@/hooks/use-books';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Library, BookOpen, Shield, RefreshCw, FolderOpen, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AddLibraryDialog } from '@/components/libraries/add-library-dialog';

export default function AdminDashboardPage() {
  const { data: libraries, isLoading: loadingLibs } = useLibraries();
  const { data: allBooks, isLoading: loadingBooks } = useBooks({ limit: 1 });
  const scanLibrary = useScanLibrary();

  const stats = [
    {
      title: 'Libraries',
      value: libraries?.length || 0,
      icon: Library,
      color: 'text-blue-500',
      bg: 'bg-blue-500/10',
    },
    {
      title: 'Total Books',
      value: allBooks?.total || 0,
      icon: BookOpen,
      color: 'text-green-500',
      bg: 'bg-green-500/10',
    },
    {
      title: 'Pending Metadata',
      value: 0,
      icon: RefreshCw,
      color: 'text-yellow-500',
      bg: 'bg-yellow-500/10',
    },
    {
      title: 'Users',
      value: 1,
      icon: Shield,
      color: 'text-purple-500',
      bg: 'bg-purple-500/10',
    },
  ];

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground sm:text-3xl">Admin Dashboard</h1>
          <p className="mt-1 text-muted-foreground">
            System overview and management
          </p>
        </div>
        <AddLibraryDialog
          trigger={(
            <Button>
              <FolderOpen className="mr-2 h-4 w-4" />
              Add Directory Library
            </Button>
          )}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {stats.map((stat) => {
          const Icon = stat.icon;
          return (
            <Card key={stat.title}>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">
                  {stat.title}
                </CardTitle>
                <div className={`rounded-lg p-2 ${stat.bg}`}>
                  <Icon className={`h-4 w-4 ${stat.color}`} />
                </div>
              </CardHeader>
              <CardContent>
                {loadingLibs || loadingBooks ? (
                  <Skeleton className="h-8 w-16" />
                ) : (
                  <div className="text-2xl font-bold">{stat.value}</div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle>Libraries Overview</CardTitle>
            <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
              <Button variant="outline" size="sm" asChild>
                <Link href="/libraries">
                  <FolderOpen className="mr-1 h-4 w-4" />
                  Manage
                </Link>
              </Button>
              <AddLibraryDialog
                trigger={(
                  <Button size="sm">
                    <Plus className="mr-1 h-4 w-4" />
                    Add Directory
                  </Button>
                )}
              />
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loadingLibs ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : libraries && libraries.length > 0 ? (
            <div className="divide-y divide-border">
              {libraries.map((lib) => (
                <div
                  key={lib.id}
                  className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="min-w-0">
                    <p className="text-sm font-medium">{lib.name}</p>
                    <p className="break-all text-xs text-muted-foreground">{lib.path}</p>
                  </div>
                  <div className="flex items-center justify-between gap-2 sm:justify-end">
                    <span className="text-sm text-muted-foreground">
                      {lib.book_count} books
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => scanLibrary.mutate(lib.id)}
                      disabled={scanLibrary.isPending}
                    >
                      <RefreshCw className="mr-1 h-3 w-3" />
                      Scan
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted-foreground">No libraries configured.</p>
              <AddLibraryDialog
                trigger={(
                  <Button size="sm">
                    <Plus className="mr-1 h-4 w-4" />
                    Add Library
                  </Button>
                )}
              />
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
