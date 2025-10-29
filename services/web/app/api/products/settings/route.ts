import { NextRequest, NextResponse } from 'next/server';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';

const SETTINGS_DIR = join(process.cwd(), '.settings');
const SETTINGS_FILE = join(SETTINGS_DIR, 'enrichment.json');

interface EnrichmentSettings {
  threshold: number;
  updatedAt: string;
  updatedBy: string;
}

const DEFAULT_SETTINGS: EnrichmentSettings = {
  threshold: 0.80,
  updatedAt: new Date().toISOString(),
  updatedBy: 'system',
};

async function ensureSettingsDir() {
  if (!existsSync(SETTINGS_DIR)) {
    await mkdir(SETTINGS_DIR, { recursive: true });
  }
}

async function loadSettings(): Promise<EnrichmentSettings> {
  try {
    await ensureSettingsDir();
    if (existsSync(SETTINGS_FILE)) {
      const content = await readFile(SETTINGS_FILE, 'utf-8');
      return JSON.parse(content);
    }
  } catch (error) {
    console.error('Error loading settings:', error);
  }
  return DEFAULT_SETTINGS;
}

async function saveSettings(settings: EnrichmentSettings): Promise<void> {
  await ensureSettingsDir();
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
}

/**
 * GET /api/products/settings
 *
 * Get enrichment settings
 */
export async function GET(req: NextRequest) {
  try {
    const settings = await loadSettings();
    return NextResponse.json(settings);
  } catch (error) {
    console.error('Error getting settings:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to get settings' } },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/products/settings
 *
 * Update enrichment settings
 */
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    const { threshold, updatedBy } = body;

    // Validation
    if (typeof threshold !== 'number') {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'threshold must be a number' } },
        { status: 400 }
      );
    }

    if (threshold < 0 || threshold > 1) {
      return NextResponse.json(
        { error: { code: 'INVALID_REQUEST', message: 'threshold must be between 0 and 1' } },
        { status: 400 }
      );
    }

    const settings: EnrichmentSettings = {
      threshold,
      updatedAt: new Date().toISOString(),
      updatedBy: updatedBy || 'admin',
    };

    await saveSettings(settings);

    return NextResponse.json(settings);
  } catch (error) {
    console.error('Error updating settings:', error);
    return NextResponse.json(
      { error: { code: 'INTERNAL_ERROR', message: 'Failed to update settings' } },
      { status: 500 }
    );
  }
}
