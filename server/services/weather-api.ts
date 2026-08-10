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
}

interface WeatherCache {
  location: string;
  forecasts: WeatherForecast[];
  fetchedAt: Date;
}

// Redis cache replaces in-memory cache for distributed caching
// const weatherCache = new Map<string, WeatherCache>();
// const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

// Check if mock data is allowed (only in development/demo mode)
const ALLOW_MOCK_WEATHER = process.env.NODE_ENV !== 'production' || process.env.ALLOW_MOCK_WEATHER === 'true';

/**
 * Get weather forecast for a location
 * In production, requires OPENWEATHER_API_KEY or ALLOW_MOCK_WEATHER=true
 */
export async function getWeatherForecast(lat: number, lon: number, hours: number = 24): Promise<WeatherForecast[]> {
  
  // Use real API if key is available
  if (ENV.openWeatherApiKey) {
    try {
      return await getWeatherFromAPI(lat, lon, hours, ENV.openWeatherApiKey);
    } catch (error) {
      console.error('[Weather] API call failed:', error);
      if (!ALLOW_MOCK_WEATHER) {
        throw new Error('Weather API unavailable and mock data not allowed in production');
      }
      console.warn('[Weather] Falling back to mock data (non-production mode)');
      return generateMockForecast(hours);
    }
  }
  
  // No API key - check if mock is allowed
  if (!ALLOW_MOCK_WEATHER) {
    throw new Error('OPENWEATHER_API_KEY is required in production. Set ALLOW_MOCK_WEATHER=true to use mock data.');
  }
  
  console.warn('[Weather] No API key configured, using mock data (non-production mode)');
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
