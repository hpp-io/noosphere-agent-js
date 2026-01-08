import { Router, Request, Response } from 'express';
import { getAgentManager } from '../services/agent-manager';
import { getDatabase } from '../../lib/db';

const router = Router();

/**
 * GET /api/agents
 * Get all agents status
 */
router.get('/', (_req: Request, res: Response) => {
  try {
    const manager = getAgentManager();
    res.json(manager.getStatus());
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/agents/:id
 * Get specific agent status
 */
router.get('/:id', (req: Request, res: Response) => {
  try {
    const manager = getAgentManager();
    const agent = manager.getAgent(req.params.id);

    if (!agent) {
      return res.status(404).json({ error: 'Agent not found' });
    }

    res.json(agent.getStatus());
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * POST /api/agents
 * Create a new agent
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { id, name, configPath, keystorePassword } = req.body;

    if (!id || !configPath || !keystorePassword) {
      return res.status(400).json({ error: 'id, configPath, and keystorePassword are required' });
    }

    const manager = getAgentManager();
    const agent = await manager.createAgent({ id, name, configPath, keystorePassword });

    res.status(201).json(agent.getStatus());
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * DELETE /api/agents/:id
 * Stop and remove an agent
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const manager = getAgentManager();
    await manager.stopAgent(req.params.id);
    res.json({ success: true, message: `Agent ${req.params.id} stopped` });
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

/**
 * GET /api/agents/:id/events
 * Get events for a specific agent
 */
router.get('/:id/events', (req: Request, res: Response) => {
  try {
    const limit = parseInt(req.query.limit as string) || 50;
    const offset = parseInt(req.query.offset as string) || 0;

    const db = getDatabase();
    const result = db.getEvents(limit, offset);

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

export default router;
