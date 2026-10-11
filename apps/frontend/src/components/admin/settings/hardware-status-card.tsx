'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Cpu, CheckCircle2, XCircle, HardDrive } from 'lucide-react';

export interface GpuDevice {
  index: number;
  name: string;
  compute_capability: string;
}

interface HardwareStatusCardProps {
  available: boolean;
  deviceCount: number;
  deviceName: string | null;
  driverVersion: string | null;
  devices: GpuDevice[];
  selectedGpuIndex: string;
}

export function HardwareStatusCard({ available, deviceCount, deviceName, driverVersion, devices, selectedGpuIndex }: HardwareStatusCardProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Cpu className="h-5 w-5 text-primary" />
          <CardTitle>Hardware</CardTitle>
        </div>
        <CardDescription>Detected hardware acceleration</CardDescription>
      </CardHeader>
      <CardContent>
        {available ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-green-500" />
              <span className="font-medium text-foreground">GPU Available</span>
              {deviceName && <Badge variant="secondary">{deviceName}</Badge>}
            </div>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <HardDrive className="h-4 w-4" />
              <span>{deviceCount} device(s){driverVersion ? ` · CUDA ${driverVersion}` : ''}</span>
            </div>
            {devices.length > 0 && (
              <div className="space-y-1 pt-2">
                {devices.map((device) => (
                  <div key={device.index} className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Badge variant={String(device.index) === selectedGpuIndex ? 'default' : 'outline'}>
                      GPU {device.index}
                    </Badge>
                    <span>{device.name}</span>
                    <span>CC {device.compute_capability}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <XCircle className="h-5 w-5 text-muted-foreground" />
            <span className="text-muted-foreground">No GPU detected — using CPU</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
