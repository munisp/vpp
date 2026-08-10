/**
 * Power Flow Widget
 * Real-time animated visualization of energy flow
 */

import { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Zap, Battery, Home, Grid3x3 } from 'lucide-react';

interface PowerFlowData {
  generation: number; // W
  consumption: number; // W
  batteryPower: number; // W (positive = charging, negative = discharging)
  batteryLevel: number; // %
  gridPower: number; // W (positive = importing, negative = exporting)
}

interface PowerFlowWidgetProps {
  data: PowerFlowData;
}

export default function PowerFlowWidget({ data }: PowerFlowWidgetProps) {
  const [animationKey, setAnimationKey] = useState(0);

  // Trigger animation on data change
  useEffect(() => {
    setAnimationKey(prev => prev + 1);
  }, [data]);

  const isGenerating = data.generation > 0;
  const isConsuming = data.consumption > 0;
  const isBatteryCharging = data.batteryPower > 0;
  const isBatteryDischarging = data.batteryPower < 0;
  const isGridImporting = data.gridPower > 0;
  const isGridExporting = data.gridPower < 0;

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="h-5 w-5 text-green-600" />
          Live Power Flow
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="relative h-[300px] flex items-center justify-center">
          {/* SVG Power Flow Diagram */}
          <svg viewBox="0 0 400 300" className="w-full h-full">
            {/* Solar Panel (Top) */}
            <g transform="translate(200, 30)">
              <rect
                x="-30"
                y="-20"
                width="60"
                height="40"
                fill="#16a34a"
                rx="5"
                className={isGenerating ? 'animate-pulse' : ''}
              />
              <Zap className="absolute top-8 left-1/2 -translate-x-1/2 h-6 w-6 text-white" />
              <text x="0" y="35" textAnchor="middle" fill="#333" fontSize="12" fontWeight="bold">
                {(data.generation / 1000).toFixed(2)} kW
              </text>
            </g>

            {/* Home (Center) */}
            <g transform="translate(200, 150)">
              <circle
                cx="0"
                cy="0"
                r="35"
                fill="#f3f4f6"
                stroke="#16a34a"
                strokeWidth="3"
                className={isConsuming ? 'animate-pulse' : ''}
              />
              <Home className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-8 w-8 text-green-600" />
              <text x="0" y="55" textAnchor="middle" fill="#333" fontSize="12" fontWeight="bold">
                {(data.consumption / 1000).toFixed(2)} kW
              </text>
            </g>

            {/* Battery (Left) */}
            <g transform="translate(70, 150)">
              <rect
                x="-25"
                y="-20"
                width="50"
                height="40"
                fill="#fbbf24"
                rx="5"
                className={isBatteryCharging || isBatteryDischarging ? 'animate-pulse' : ''}
              />
              <Battery className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-6 w-6 text-white" />
              <text x="0" y="35" textAnchor="middle" fill="#333" fontSize="12" fontWeight="bold">
                {data.batteryLevel}%
              </text>
              <text x="0" y="50" textAnchor="middle" fill="#333" fontSize="10">
                {Math.abs(data.batteryPower / 1000).toFixed(2)} kW
              </text>
            </g>

            {/* Grid (Right) */}
            <g transform="translate(330, 150)">
              <rect
                x="-25"
                y="-20"
                width="50"
                height="40"
                fill="#3b82f6"
                rx="5"
                className={isGridImporting || isGridExporting ? 'animate-pulse' : ''}
              />
              <Grid3x3 className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-6 w-6 text-white" />
              <text x="0" y="35" textAnchor="middle" fill="#333" fontSize="12" fontWeight="bold">
                {isGridExporting ? 'Export' : 'Import'}
              </text>
              <text x="0" y="50" textAnchor="middle" fill="#333" fontSize="10">
                {Math.abs(data.gridPower / 1000).toFixed(2)} kW
              </text>
            </g>

            {/* Flow Lines with Animation */}
            {/* Solar to Home */}
            {isGenerating && (
              <>
                <line
                  x1="200"
                  y1="70"
                  x2="200"
                  y2="115"
                  stroke="#16a34a"
                  strokeWidth="3"
                  markerEnd="url(#arrowGreen)"
                />
                <AnimatedDot
                  key={`solar-home-${animationKey}`}
                  x1={200}
                  y1={70}
                  x2={200}
                  y2={115}
                  color="#16a34a"
                />
              </>
            )}

            {/* Home to Battery (Charging) */}
            {isBatteryCharging && (
              <>
                <line
                  x1="165"
                  y1="150"
                  x2="95"
                  y2="150"
                  stroke="#fbbf24"
                  strokeWidth="3"
                  markerEnd="url(#arrowYellow)"
                />
                <AnimatedDot
                  key={`home-battery-${animationKey}`}
                  x1={165}
                  y1={150}
                  x2={95}
                  y2={150}
                  color="#fbbf24"
                />
              </>
            )}

            {/* Battery to Home (Discharging) */}
            {isBatteryDischarging && (
              <>
                <line
                  x1="95"
                  y1="150"
                  x2="165"
                  y2="150"
                  stroke="#fbbf24"
                  strokeWidth="3"
                  markerEnd="url(#arrowYellow)"
                />
                <AnimatedDot
                  key={`battery-home-${animationKey}`}
                  x1={95}
                  y1={150}
                  x2={165}
                  y2={150}
                  color="#fbbf24"
                />
              </>
            )}

            {/* Home to Grid (Exporting) */}
            {isGridExporting && (
              <>
                <line
                  x1="235"
                  y1="150"
                  x2="305"
                  y2="150"
                  stroke="#3b82f6"
                  strokeWidth="3"
                  markerEnd="url(#arrowBlue)"
                />
                <AnimatedDot
                  key={`home-grid-${animationKey}`}
                  x1={235}
                  y1={150}
                  x2={305}
                  y2={150}
                  color="#3b82f6"
                />
              </>
            )}

            {/* Grid to Home (Importing) */}
            {isGridImporting && (
              <>
                <line
                  x1="305"
                  y1="150"
                  x2="235"
                  y2="150"
                  stroke="#3b82f6"
                  strokeWidth="3"
                  markerEnd="url(#arrowBlue)"
                />
                <AnimatedDot
                  key={`grid-home-${animationKey}`}
                  x1={305}
                  y1={150}
                  x2={235}
                  y2={150}
                  color="#3b82f6"
                />
              </>
            )}

            {/* Arrow Markers */}
            <defs>
              <marker
                id="arrowGreen"
                markerWidth="10"
                markerHeight="10"
                refX="5"
                refY="3"
                orient="auto"
                markerUnits="strokeWidth"
              >
                <path d="M0,0 L0,6 L9,3 z" fill="#16a34a" />
              </marker>
              <marker
                id="arrowYellow"
                markerWidth="10"
                markerHeight="10"
                refX="5"
                refY="3"
                orient="auto"
                markerUnits="strokeWidth"
              >
                <path d="M0,0 L0,6 L9,3 z" fill="#fbbf24" />
              </marker>
              <marker
                id="arrowBlue"
                markerWidth="10"
                markerHeight="10"
                refX="5"
                refY="3"
                orient="auto"
                markerUnits="strokeWidth"
              >
                <path d="M0,0 L0,6 L9,3 z" fill="#3b82f6" />
              </marker>
            </defs>
          </svg>
        </div>

        {/* Legend */}
        <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-green-600" />
            <span>Generation</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-yellow-500" />
            <span>Battery</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-blue-500" />
            <span>Grid</span>
          </div>
          <div className="flex items-center gap-2">
            <div className="w-3 h-3 rounded-full bg-gray-400" />
            <span>Consumption</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * Animated dot component for power flow
 */
function AnimatedDot({
  x1,
  y1,
  x2,
  y2,
  color,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: string;
}) {
  return (
    <circle r="4" fill={color}>
      <animateMotion dur="2s" repeatCount="indefinite">
        <mpath xlinkHref={`#path-${x1}-${y1}-${x2}-${y2}`} />
      </animateMotion>
      <animate
        attributeName="opacity"
        values="1;0.5;1"
        dur="2s"
        repeatCount="indefinite"
      />
    </circle>
  );
}
