'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { BookOpen, Library } from 'lucide-react';
import { routes } from '@/lib/routes';

const THEME_KEY = 'reading-theme';
const FONT_SIZE_KEY = 'reading-font-size';

export function ReadingPrefsCard() {
  const [theme, setTheme] = useState('dark');
  const [fontSize, setFontSize] = useState('medium');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    try {
      const t = localStorage.getItem(THEME_KEY);
      const f = localStorage.getItem(FONT_SIZE_KEY);
      if (t) setTheme(t);
      if (f) setFontSize(f);
    } catch {
      // localStorage unavailable (private mode) — keep defaults
    }
  }, []);

  const handleSave = () => {
    try {
      localStorage.setItem(THEME_KEY, theme);
      localStorage.setItem(FONT_SIZE_KEY, fontSize);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      // ignore write failures
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Reading Preferences</CardTitle>
        <CardDescription>Customize your reading experience. Saved on this device.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium">
              <BookOpen className="h-4 w-4 text-muted-foreground" />
              Default Theme
            </label>
            <Select value={theme} onValueChange={setTheme}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="dark">Dark</SelectItem>
                <SelectItem value="light">Light</SelectItem>
                <SelectItem value="sepia">Sepia</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium">
              <BookOpen className="h-4 w-4 text-muted-foreground" />
              Default Font Size
            </label>
            <Select value={fontSize} onValueChange={setFontSize}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="small">Small</SelectItem>
                <SelectItem value="medium">Medium</SelectItem>
                <SelectItem value="large">Large</SelectItem>
                <SelectItem value="xlarge">Extra Large</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={handleSave}>Save Preferences</Button>
          {saved && <span className="text-sm text-green-600">Saved on this device.</span>}
        </div>
      </CardContent>
    </Card>
  );
}

export function LibrariesCtaCard() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Library Management</CardTitle>
        <CardDescription>Libraries are managed by administrators.</CardDescription>
      </CardHeader>
      <CardContent>
        <Button asChild variant="outline">
          <Link href={routes.libraries}>
            <Library className="mr-2 h-4 w-4" />
            Browse Libraries
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}
