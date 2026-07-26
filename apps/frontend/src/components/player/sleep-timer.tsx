'use client';

import { Button } from '@/components/ui/button';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { Timer, Clock } from 'lucide-react';
import { cn } from '@/lib/utils';

interface SleepTimerProps {
  isActive: boolean;
  remainingMinutes?: number;
  onSetTimer: (minutes: number) => void;
  onClearTimer: () => void;
  className?: string;
}

const presets = [
  { label: '15 min', value: 15 },
  { label: '30 min', value: 30 },
  { label: '45 min', value: 45 },
  { label: '60 min', value: 60 },
  { label: 'End of chapter', value: -1 },
];

export function SleepTimer({
  isActive,
  remainingMinutes,
  onSetTimer,
  onClearTimer,
  className,
}: SleepTimerProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(isActive && 'text-primary', className)}
        >
          <Timer className="h-4 w-4" />
          {isActive && remainingMinutes !== undefined && (
            <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] text-primary-foreground">
              {remainingMinutes}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="z-50 w-48 rounded-md border border-border bg-popover p-2 shadow-md"
        align="end"
      >
        <div className="space-y-1">
          <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
            Sleep Timer
          </p>
          {isActive && (
            <Button
              variant="ghost"
              size="sm"
              className="w-full justify-start text-destructive"
              onClick={onClearTimer}
            >
              <Clock className="mr-2 h-4 w-4" />
              Disable timer
            </Button>
          )}
          {presets.map((preset) => (
            <Button
              key={preset.value}
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              onClick={() => onSetTimer(preset.value)}
            >
              <Clock className="mr-2 h-4 w-4" />
              {preset.label}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
