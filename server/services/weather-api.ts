/**
 * Weather API Integration
 * 
 * Integrates with OpenWeatherMap API for weather forecasts to enhance ML price predictions
 */

import { redisCache } from './redis-cache';
import { ENV } from '../_core/env';

interface WeatherForecast {
  timestamp: Date;
  temperature: number; // Celsius
  cloudCover: number; // 0-100%
  precipitation: number; // mm
  windSpeed: number; // m/s
  solarIrradiance: number; // W/m² (estimated from cloud cover)
  mock?: boolean; // true when this point comes from generated mock data
}

interface WeatherCache {
  location: string;
  forecasts: WeatherForecast[];
  fetchedAt: Date;
}

// Redis cache replaces in-memory cache for distributed caching
// const weatherCache = new Map<string, WeatherCache>();
// const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Mock data is allowed ONLY when explicitly opted in via ALLOW_MOCK_WEATHER=true,
// regardless of NODE_ENV. Never silently fall back to mock data otherwise.
const ALLOW_MOCK_WEATHER = process.env.ALLOW_MOCK_WEATHER === 'true';

/**
 * Get weather forecast for a location
 * Requires OPENWEATHER_API_KEY unless ALLOW_MOCK_WEATHER=true is explicitly set.
 * Mock forecasts are marked with `mock: true` so downstream consumers can tell.
 */
export async function getWeatherForecast(lat: number, lon: number, hours: number = 24): Promise<WeatherForecast[]> {

  // Use real API if key is available
  if (ENV.openWeatherApiKey) {
    try {
      return await getWeatherFromAPI(lat, lon, hours, ENV.openWeatherApiKey);
    } catch (error) {
      console.error('[Weather] API call failed:', error);
      if (!ALLOW_MOCK_WEATHER) {
        throw new Error('Weather API unavailable and mock data not allowed (set ALLOW_MOCK_WEATHER=true to opt in)');
      }
      console.warn('[Weather] Falling back to mock data (ALLOW_MOCK_WEATHER=true)');
      return generateMockForecast(hours);
    }
  }

  // No API key - check if mock is explicitly allowed
  if (!ALLOW_MOCK_WEATHER) {
    throw new Error('OPENWEATHER_API_KEY is required. Set ALLOW_MOCK_WEATHER=true to explicitly use mock data.');
  }

  console.warn('[Weather] No API key configured, using mock data (ALLOW_MOCK_WEATHER=true)');
  return generateMockForecast(hours);
}

/**
 * Fetch weather data from OpenWeather API
 */
async function getWeatherFromAPI(lat: number, lon: number, hours: number, apiKey: string): Promise<WeatherForecast[]> {
  // Check Redis cache first
  const cached = await redisCache.getWeatherForecast(lat, lon);
  if (cached && Array.isArray(cached)) {
    console.log('[Weather API] Using Redis cached forecast');
    return cached.slice(0, hours);
  }

  // Fetch from OpenWeatherMap
  try {
    const url = `https://api.openweathermap.org/data/2.5/forecast?lat=${lat}&lon=${lon}&appid=${apiKey}&units=metric`;
    const response = await fetch(url);
    
    if (!response.ok) {
      throw new Error(`Weather API error: ${response.statusText}`);
    }

    const data = await response.json();
    const forecasts = parseOpenWeatherResponse(data, hours);

    // Update Redis cache (1 hour TTL)
    await redisCache.cacheWeatherForecast(lat, lon, forecasts);

    console.log(`[Weather API] Fetched ${forecasts.length} forecast points`);
    return forecasts;
  } catch (error: any) {
    console.error('[Weather API] Failed to fetch forecast:', error);
    // Respect the mock gate: never silently substitute mock data for a real API
    // failure. In production this must surface as an explicit error.
    if (!ALLOW_MOCK_WEATHER) {
      throw new Error(`Weather API fetch failed and mock data not allowed (set ALLOW_MOCK_WEATHER=true to opt in): ${error?.message || error}`);
    }
    console.warn('[Weather API] Falling back to mock data (ALLOW_MOCK_WEATHER=true)');
    return generateMockForecast(hours);
  }
}

/**
 * Parse OpenWeatherMap API response
 */
function parseOpenWeatherResponse(data: any, maxHours: number): WeatherForecast[] {
  const forecasts: WeatherForecast[] = [];
  const maxPoints = Math.ceil(maxHours / 3); // OpenWeather provides 3-hour intervals

  for (let i = 0; i < Math.min(data.list.length, maxPoints); i++) {
    const item = data.list[i];
    const cloudCover = item.clouds.all; // 0-100%
    
    // Estimate solar irradiance from cloud cover
    // Clear sky: ~1000 W/m², Overcast: ~100 W/m²
    const solarIrradiance = 1000 * (1 - (cloudCover / 100) * 0.9);

    forecasts.push({
      timestamp: new Date(item.dt * 1000),
      temperature: item.main.temp,
      cloudCover,
      precipitation: item.rain?.['3h'] || 0,
      windSpeed: item.wind.speed,
      solarIrradiance,
    });
  }

  return forecasts;
}

/**
 * Generate mock forecast data for testing
 */
function generateMockForecast(hours: number): WeatherForecast[] {
  const forecasts: WeatherForecast[] = [];
  const now = new Date();

  for (let i = 0; i < hours; i++) {
    const timestamp = new Date(now.getTime() + i * 60 * 60 * 1000);
    const hour = timestamp.getHours();
    
    // Simulate daily pattern
    const isDaytime = hour >= 6 && hour <= 18;
    const cloudCover = 20 + Math.random() * 40; // 20-60%
    const solarIrradiance = isDaytime ? 800 * (1 - cloudCover / 100) : 0;

    forecasts.push({
      timestamp,
      temperature: 25 + Math.sin(hour / 24 * Math.PI * 2) * 5,
      cloudCover,
      precipitation: Math.random() < 0.1 ? Math.random() * 5 : 0,
      windSpeed: 2 + Math.random() * 3,
      solarIrradiance,
      mock: true, // explicitly marked so downstream consumers can detect mock data
    });
  }

  return forecasts;
}

/**
 * Estimate solar generation potential from weather forecast
 */
export function estimateSolarGeneration(
  forecast: WeatherForecast,
  installedCapacityKW: number
): number {
  // Standard Test Conditions (STC): 1000 W/m²
  const efficiency = 0.18; // Typical solar panel efficiency
  const performanceRatio = 0.75; // Account for losses

  const generationKW = 
    (forecast.solarIrradiance / 1000) * 
    installedCapacityKW * 
    efficiency * 
    performanceRatio;

  return Math.max(0, generationKW);
}

/**
 * Clear weather cache (for testing or manual refresh)
 */
export async function clearWeatherCache(latitude?: number, longitude?: number): Promise<void> {
  if (latitude !== undefined && longitude !== undefined) {
    await redisCache.del(`weather:${latitude}:${longitude}`);
    console.log(`[Weather API] Cache cleared for ${latitude},${longitude}`);
  } else {
    await redisCache.delPattern('weather:*');
    console.log('[Weather API] All weather cache cleared');
  }
}
