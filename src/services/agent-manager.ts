import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import { ContainerManager } from '@noosphere/agent-core';
import { AgentInstance } from './agent-instance';
import { logger } from '../../lib/logger';
import { AgentConfigFile, AgentInstanceConfig, AgentManagerStatus } from '../types';

export class AgentManager extends EventEmitter {
  private agents = new Map<string, AgentInstance>();
  private containerManager = new ContainerManager();

  /**
   * Load and start agents from config
   */
  async startFromConfig(): Promise<void> {
    const configs = this.loadConfigs();

    for (const config of configs) {
      if (config.enabled === false) {
        logger.info(`[${config.id}] Skipping disabled agent`);
        continue;
      }

      // Retry logic for agent creation
      const maxRetries = 3;
      const retryDelayMs = 10000; // 10 seconds

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          await this.createAgent(config);
          break; // Success, exit retry loop
        } catch (error) {
          const errorMessage = (error as Error).message;
          logger.error(`[${config.id}] Failed to create agent (attempt ${attempt}/${maxRetries}): ${errorMessage}`);

          if (attempt < maxRetries) {
            logger.info(`[${config.id}] Retrying in ${retryDelayMs / 1000} seconds...`);
            await new Promise(resolve => setTimeout(resolve, retryDelayMs));
          } else {
            logger.error(`[${config.id}] All ${maxRetries} attempts failed. Agent will not start.`);
          }
        }
      }
    }
  }

  private loadConfigs(): AgentInstanceConfig[] {
    // Check for multi-agent config (agents.json)
    const multiConfigPath = path.join(process.cwd(), 'agents.json');

    if (fs.existsSync(multiConfigPath)) {
      logger.info('Loading multi-agent config from agents.json');
      const multiConfig = JSON.parse(fs.readFileSync(multiConfigPath, 'utf-8'));
      const agents = (multiConfig.agents || []).map((agent: AgentInstanceConfig) => ({
        ...agent,
        // Support ${ENV_VAR} substitution in keystorePassword
        keystorePassword: agent.keystorePassword?.replace(/\$\{(\w+)\}/g, (_, envVar) =>
          process.env[envVar] || ''
        ) || '',
      }));
      return agents;
    }

    // Fallback to single agent (config.json)
    const singleConfigPath = path.join(process.cwd(), 'config.json');

    if (fs.existsSync(singleConfigPath)) {
      logger.info('Loading single-agent config from config.json');
      return [{
        id: 'default',
        name: 'Default Agent',
        configPath: singleConfigPath,
        keystorePassword: process.env.KEYSTORE_PASSWORD || '',
        enabled: true,
      }];
    }

    throw new Error('No config found. Create config.json or agents.json');
  }

  /**
   * Create and start a new agent
   */
  async createAgent(instanceConfig: AgentInstanceConfig): Promise<AgentInstance> {
    const { id, name, configPath, keystorePassword } = instanceConfig;

    if (this.agents.has(id)) {
      throw new Error(`Agent ${id} already exists`);
    }

    // Load agent config file
    const absolutePath = path.isAbsolute(configPath)
      ? configPath
      : path.join(process.cwd(), configPath);
    const config: AgentConfigFile = JSON.parse(fs.readFileSync(absolutePath, 'utf-8'));

    // Create agent instance (ABIs are loaded from @noosphere/contracts by default)
    const agent = new AgentInstance(
      id,
      name,
      config,
      keystorePassword,
    );

    // Forward events
    agent.on('requestStarted', (data) => this.emit('requestStarted', data));
    agent.on('computeDelivered', (data) => this.emit('computeDelivered', data));
    agent.on('started', (data) => this.emit('agentStarted', data));
    agent.on('stopped', (data) => this.emit('agentStopped', data));
    agent.on('epochRegistered', (data) => this.emit('epochRegistered', data));
    agent.on('epochRunningLow', (data) => this.emit('epochRunningLow', data));
    agent.on('epochRegistrationFailed', (data) => this.emit('epochRegistrationFailed', data));

    // Initialize and start
    await agent.initialize();
    await agent.start();

    this.agents.set(id, agent);
    logger.info(`Agent ${id} added (total: ${this.agents.size})`);

    return agent;
  }

  /**
   * Stop and remove an agent
   */
  async stopAgent(id: string): Promise<void> {
    const agent = this.agents.get(id);
    if (!agent) {
      throw new Error(`Agent ${id} not found`);
    }

    await agent.stop();
    this.agents.delete(id);
    logger.info(`Agent ${id} removed (total: ${this.agents.size})`);
  }

  /**
   * Get agent by ID
   */
  getAgent(id: string): AgentInstance | undefined {
    return this.agents.get(id);
  }

  /**
   * Get all agents
   */
  getAllAgents(): AgentInstance[] {
    return Array.from(this.agents.values());
  }

  /**
   * Get manager status
   */
  getStatus(): AgentManagerStatus {
    const agents = this.getAllAgents().map((agent) => agent.getStatus());
    return {
      totalAgents: agents.length,
      runningAgents: agents.filter((a) => a.running).length,
      agents,
    };
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    logger.info('Shutting down all agents...');

    for (const [id, agent] of this.agents) {
      try {
        await agent.stop();
        logger.info(`[${id}] Agent stopped`);
      } catch (error) {
        logger.error(`[${id}] Error stopping: ${(error as Error).message}`);
      }
    }

    this.agents.clear();
    await this.containerManager.stopPersistentContainers();
    logger.info('All agents stopped');
  }
}

// Singleton instance
let instance: AgentManager | null = null;

export function getAgentManager(): AgentManager {
  if (!instance) {
    instance = new AgentManager();
  }
  return instance;
}
