import { createPublicClient, http, watchContractEvent, GetContractReturnType } from 'viem';
import { polygonAmoy } from 'viem/chains';
import { lolhubFunTokenABI, erc20Abi } from '@/lib/abis';

class WebSocketManager {
  private static instance: WebSocketManager;
  private connections = new Map<string, { 
    unwatch: () => void; 
    lastActivity: number;
    client: any;
  }>();
  private cleanupInterval: NodeJS.Timeout;
  private readonly INACTIVE_THRESHOLD = 10 * 60 * 1000; // 10 dakika
  private readonly CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 dakikada bir

  private constructor() {
    this.cleanupInterval = setInterval(() => this.cleanupInactiveConnections(), this.CLEANUP_INTERVAL);
    this.setupPageUnloadHandler();
  }

  private setupPageUnloadHandler() {
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => {
        this.cleanupAllConnections();
      });
      
      // Sayfa arka plandayken bağlantıyı azalt
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
          this.reduceConnectionActivity();
        }
      });
    }
  }

  public static getInstance(): WebSocketManager {
    if (!WebSocketManager.instance) {
      WebSocketManager.instance = new WebSocketManager();
    }
    return WebSocketManager.instance;
  }

  public async watchProjectEvents(
    projectAddress: string, 
    onInvestedEvent: (event: any) => void,
    chainId: number = polygonAmoy.id,
    userRpcUrl?: string
  ) {
    const projectId = projectAddress.toLowerCase();
    const existingConnection = this.connections.get(projectId);
    
    if (existingConnection) {
      existingConnection.lastActivity = Date.now();
      console.log(`[WS] Existing connection reused for ${projectId}`);
      return;
    }

    try {
      // Hibrit RPC ile client oluştur
      const publicClient = await this.getPublicClientWithFallback(chainId, userRpcUrl);
      
      const unwatch = watchContractEvent(publicClient, {
        address: projectAddress as `0x${string}`,
        abi: lolhubFunTokenABI,
        eventName: 'Invested',
        onLogs: (logs) => {
          logs.forEach(log => {
            onInvestedEvent(log);
            this.updateActivity(projectId);
          });
        },
        onError: (error) => {
          console.error(`[WS-ERROR] Project ${projectId}:`, error);
          this.cleanupConnection(projectId);
        },
      });

      this.connections.set(projectId, {
        unwatch,
        lastActivity: Date.now(),
        client: publicClient
      });

      console.log(`[WS] New connection created for ${projectId} on chain ${chainId}`);
      
    } catch (error) {
      console.error(`[WS-INIT-ERROR] Failed to create connection for ${projectId}:`, error);
      // Fallback olarak tekrar dene
      setTimeout(() => this.retryConnection(projectId, onInvestedEvent, chainId), 5000);
    }
  }

  private async getPublicClientWithFallback(chainId: number, userRpcUrl?: string) {
    const config = {
      timeout: 2000,
      fallbackRpc: process.env.NEXT_PUBLIC_INFURA_AMOY_RPC_URL
    };

    try {
      const [userResult, fallbackResult] = await Promise.race([
        Promise.all([
          this.createClient(chainId, userRpcUrl, config.timeout),
          this.createClient(chainId, config.fallbackRpc, config.timeout)
        ]),
        new Promise(resolve => setTimeout(() => resolve([null, null]), config.timeout))
      ]);

      return userResult || fallbackResult || await this.createClient(chainId, config.fallbackRpc, config.timeout * 2);
      
    } catch (error) {
      console.error('[RPC-FALLBACK] All RPCs failed, using last resort:', error);
      return this.createClient(chainId, config.fallbackRpc, 5000);
    }
  }

  private async createClient(chainId: number, rpcUrl?: string, timeout: number = 2000) {
    if (!rpcUrl) return null;

    const chain = this.getChainById(chainId);
    const client = createPublicClient({
      chain,
      transport: http(rpcUrl, { timeout })
    });

    // Bağlantıyı test et
    await client.getBlockNumber();
    return client;
  }

  private getChainById(chainId: number) {
    switch (chainId) {
      case 1: return require('viem/chains').mainnet;
      case 137: return require('viem/chains').polygon;
      case 80002: return require('viem/chains').polygonAmoy;
      case 56: return require('viem/chains').bsc;
      case 43114: return require('viem/chains').avalanche;
      case 8453: return require('viem/chains').base;
      case 42161: return require('viem/chains').arbitrum;
      default: return require('viem/chains').polygonAmoy;
    }
  }

  private updateActivity(projectId: string) {
    const connection = this.connections.get(projectId);
    if (connection) {
      connection.lastActivity = Date.now();
    }
  }

  private cleanupInactiveConnections() {
    const now = Date.now();
    console.log(`[WS-CLEANUP] Checking ${this.connections.size} connections`);

    this.connections.forEach((connection, projectId) => {
      if (now - connection.lastActivity > this.INACTIVE_THRESHOLD) {
        console.log(`[WS-CLEANUP] Removing inactive connection for ${projectId}`);
        this.cleanupConnection(projectId);
      }
    });

    console.log(`[WS-CLEANUP] Active connections remaining: ${this.connections.size}`);
  }

  private cleanupConnection(projectId: string) {
    const connection = this.connections.get(projectId);
    if (connection) {
      try {
        connection.unwatch();
        this.connections.delete(projectId);
        console.log(`[WS] Connection closed for ${projectId}`);
      } catch (error) {
        console.error(`[WS-CLOSE-ERROR] ${projectId}:`, error);
      }
    }
  }

  private cleanupAllConnections() {
    console.log('[WS] Cleaning up ALL connections on page unload');
    this.connections.forEach((connection, projectId) => {
      try {
        connection.unwatch();
      } catch (error) {
        console.error(`[WS-CLOSE-ALL-ERROR] ${projectId}:`, error);
      }
    });
    this.connections.clear();

    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }

  private reduceConnectionActivity() {
    console.log('[WS] Reducing connection activity in background');
    this.connections.forEach((connection, projectId) => {
      // Arka plandayken polling'i azaltmak için özel işlemler
      // Bu, tarayıcı kaynak kullanımını optimize eder
    });
  }

  private async retryConnection(projectId: string, onInvestedEvent: (event: any) => void, chainId: number) {
    console.log(`[WS-RETRY] Attempting to reconnect for ${projectId}`);
    try {
      const projectData = await fetch(`/api/project/${projectId}`).then(res => res.json());
      if (projectData.success) {
        await this.watchProjectEvents(
          projectId, 
          onInvestedEvent, 
          projectData.project.chain_id || polygonAmoy.id,
          projectData.project.user_rpc_url
        );
      }
    } catch (error) {
      console.error(`[WS-RETRY-FAILED] ${projectId}:`, error);
    }
  }

  public getConnectionCount(): number {
    return this.connections.size;
  }
}

export const webSocketManager = WebSocketManager.getInstance();

export function useProjectWebSocket(projectAddress: string, onInvestedEvent: (event: any) => void) {
  const [projectData, setProjectData] = useState<any>(null);

  useEffect(() => {
    if (!projectAddress || !onInvestedEvent) return;

    // Proje verilerini al
    const fetchProjectData = async () => {
      try {
        const response = await fetch(`/api/project/${projectAddress.toLowerCase()}`);
        const data = await response.json();
        if (data.success) {
          setProjectData(data.project);
        }
      } catch (error) {
        console.error('Failed to fetch project data:', error);
      }
    };

    fetchProjectData();

    return () => {
      webSocketManager.updateActivity(projectAddress.toLowerCase());
    };
  }, [projectAddress, onInvestedEvent]);

  useEffect(() => {
    if (projectData && projectAddress && onInvestedEvent) {
      webSocketManager.watchProjectEvents(
        projectAddress,
        onInvestedEvent,
        projectData.chain_id || polygonAmoy.id,
        projectData.user_rpc_url
      );
    }
  }, [projectData, projectAddress, onInvestedEvent]);
}
