'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface SettingOption {
  value: string;
  label: string;
}

interface SettingSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: SettingOption[];
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
}

export function SettingSelect({ value, onChange, options, placeholder, disabled, ariaLabel }: SettingSelectProps) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger aria-label={ariaLabel}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
