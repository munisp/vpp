/**
 * Battery Status Widget
 * Real-time battery charge/discharge indicator
 */

import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Battery, BatteryCharging, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';

interface BatteryStatusWidgetProps {
  level: number; // 0-100
  power: number; // W (positive = charging, negative = discharging)
  voltage: number; // V
  current: number; // A
  temperature?: number; // °C
}

export default function BatteryStatusWidget({
  level,
  power,
  voltage,
  current,
  temperature,
}: BatteryStatusWidgetProps) {
  const isCharging = power > 0;
  const isDischarging = power < 0;
  const isIdle = power === 0;

  const getStatusColor = () => {
    if (level > 80) return 'text-green-600';
    if (level > 50) return 'text-yellow-600';
    if (level > 20) return 'text-orange-600';
    return 'text-red-600';
  };

  const getStatusText = () => {
    if (isCharging) return 'Charging';
    if (isDischarging) return 'Discharging';
    return 'Idle';
  };

  const getBatteryIcon = () => {
    if (isCharging) return <BatteryCharging className="h-6 w-6" />;
    return <Battery className="h-6 w-6" />;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <div className={cn(getStatusColor(), isCharging && 'animate-pulse')}>
            {getBatteryIcon()}
          </div>
          Battery Status
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Battery Level Visualization */}
        <div className="relative">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm font-medium">Level</span>
            <span className={cn('text-2xl font-bold', getStatusColor())}>
              {level}%
            </span>
          </div>
          
          {/* Battery Bar */}
          <div className="relative h-12 bg-gray-200 rounded-lg overflow-hidden border-2 border-gray-300">
            <div
              className={cn(
                'h-full transition-all duration-500 ease-out',
                level > 80 && 'bg-green-500',
                level > 50 && level <= 80 && 'bg-yellow-500',
                level > 20 && level <= 50 && 'bg-orange-500',
                level <= 20 && 'bg-red-500',
                isCharging && 'animate-pulse'
              )}
              style={{ width: `${level}%` }}
            >
              {isCharging && (
                <div className="absolute inset-0 flex items-center justify-center">
                  <Zap className="h-6 w-6 text-white animate-bounce" />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Status Badge */}
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-600">Status</span>
          <span
            className={cn(
              'px-3 py-1 rounded-full text-sm font-medium',
              isCharging && 'bg-green-100 text-green-700',
              isDischarging && 'bg-orange-100 text-orange-700',
              isIdle && 'bg-gray-100 text-gray-700'
            )}
          >
            {getStatusText()}
          </span>
        </div>

        {/* Power Flow */}
        <div className="flex items-center justify-between">
          <span className="text-sm text-gray-600">Power</span>
          <span className="text-lg font-semibold">
            {isCharging && '+'}
            {(Math.abs(power) / 1000).toFixed(2)} kW
          </span>
        </div>

        {/* Electrical Parameters */}
        <div className="grid grid-cols-2 gap-4 pt-4 border-t">
          <div>
            <div className="text-xs text-gray-500">Voltage</div>
            <div className="text-lg font-semibold">{voltage.toFixed(1)} V</div>
          </div>
          <div>
            <div className="text-xs text-gray-500">Current</div>
            <div className="text-lg font-semibold">{current.toFixed(2)} A</div>
          </div>
          {temperature !== undefined && (
            <>
              <div>
                <div className="text-xs text-gray-500">Temperature</div>
                <div className="text-lg font-semibold">{temperature.toFixed(1)} °C</div>
              </div>
              <div>
                <div className="text-xs text-gray-500">Time to Full</div>
                <div className="text-lg font-semibold">
                  {isCharging && power > 0
                    ? `${Math.round(((100 - level) / 100) * 2)}h`
                    : '--'}
                </div>
              </div>
            </>
          )}
        </div>

        {/* Charge/Discharge Rate Indicator */}
        {!isIdle && (
          <div className="pt-4 border-t">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm text-gray-600">
                {isCharging ? 'Charging Rate' : 'Discharge Rate'}
              </span>
              <span className="text-sm font-medium">
                {((Math.abs(power) / 5000) * 100).toFixed(0)}%
              </span>
            </div>
            <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                className={cn(
                  'h-full transition-all duration-500',
                  isCharging && 'bg-green-500',
                  isDischarging && 'bg-orange-500'
                )}
                style={{ width: `${(Math.abs(power) / 5000) * 100}%` }}
              />
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
