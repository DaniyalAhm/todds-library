'use client';

import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface SettingFieldProps {
  label: string;
  description?: string;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}

export function SettingField({ label, description, htmlFor, children, className }: SettingFieldProps) {
  return (
    <div className={cn('space-y-2', className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-foreground">
        {label}
      </label>
      {children}
      {description && <p className="text-xs text-muted-foreground">{description}</p>}
    </div>
  );
}
