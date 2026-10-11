'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function AboutCard() {
  const version = process.env.NEXT_PUBLIC_APP_VERSION || '0.1.0';
  return (
    <Card>
      <CardHeader>
        <CardTitle>About</CardTitle>
        <CardDescription>Application information</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 text-sm text-muted-foreground">
        <p>
          <span className="font-medium text-foreground">Todd&apos;s Library</span> v{version}
        </p>
        <p>A personal ebook and audiobook library management system.</p>
        <p className="text-xs">Built with Next.js 14, Tailwind CSS, and shadcn/ui</p>
      </CardContent>
    </Card>
  );
}
