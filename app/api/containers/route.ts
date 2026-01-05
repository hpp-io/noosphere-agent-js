import { NextResponse } from 'next/server';
import { RegistryManager } from '@noosphere/registry';
import { loadConfig } from '@/lib/config';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    // Load configuration
    const config = loadConfig();

    // Load container registry
    const registry = new RegistryManager({
      autoSync: false,
      cacheTTL: 3600000,
    });
    await registry.load();

    const stats = registry.getStats();

    // Get containers from registry
    const registryContainers = registry.listContainers();

    // Get containers from config
    const configContainers = config.containers?.map(c => {
      // Generate tags based on container ID
      const tags = ['local', 'compute'];
      if (c.id.includes('llm')) {
        tags.push('llm', 'ai');
      }
      if (c.id.includes('hello-world')) {
        tags.push('example', 'demo');
      }

      return {
        id: c.id,
        name: c.id,
        imageName: c.image,
        verified: false,
        tags,
        description: `Container: ${c.id}`,
        requirements: {},
        payments: {},
      };
    }) || [];

    // Merge containers (config takes precedence)
    const containerMap = new Map();

    // Add registry containers first
    registryContainers.forEach(c => {
      containerMap.set(c.id, {
        id: c.id,
        name: c.name,
        imageName: c.imageName,
        verified: c.verified,
        tags: c.tags,
        description: c.description,
        requirements: c.requirements,
        payments: c.payments,
      });
    });

    // Override/add config containers
    configContainers.forEach(c => {
      containerMap.set(c.id, c);
    });

    const allContainers = Array.from(containerMap.values());

    // Update stats to include config containers
    const updatedStats = {
      ...stats,
      totalContainers: allContainers.length,
      activeContainers: allContainers.length,
    };

    return NextResponse.json({
      stats: updatedStats,
      containers: allContainers,
    });
  } catch (error) {
    console.error('Error loading containers:', error);
    return NextResponse.json(
      { error: 'Failed to load containers', details: (error as Error).message },
      { status: 500 }
    );
  }
}
