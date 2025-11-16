// Manual olaraq token database-ə əlavə etmək üçün script
import { neon } from '@neondatabase/serverless';
import { createPublicClient, http, getContract } from 'viem';
import { polygonAmoy } from 'viem/chains';

// Token məlumatları
const TOKEN_ADDRESS = '0x0bc6f297a6f1a5f105f87b13a8362e911208a28d';
const CREATOR_ADDRESS = '0x083A29bad35923Eca7A378cA2468872C3e54A12A';
const TX_HASH = '0x78d851412a00fd0081a977e6c202c9fbaed0500f8c1f1e0d11bec9d51ea14066';

// Token ABI (minimal)
const TOKEN_ABI = [
  {
    inputs: [],
    name: 'name',
    outputs: [{ type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'symbol',
    outputs: [{ type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'evolutionMode',
    outputs: [{ type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'finalTargetWei',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'totalRaised',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'totalSupply',
    outputs: [{ type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'isFinalized',
    outputs: [{ type: 'bool' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

async function main() {
  console.log('🚀 Starting manual token addition...\n');

  // Database bağlantısı
  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    throw new Error('DATABASE_URL environment variable is required');
  }
  const db = neon(DATABASE_URL);

  // RPC bağlantısı
  const INFURA_RPC_URL = process.env.INFURA_AMOY_RPC_URL;
  if (!INFURA_RPC_URL) {
    throw new Error('INFURA_AMOY_RPC_URL environment variable is required');
  }

  const publicClient = createPublicClient({
    chain: polygonAmoy,
    transport: http(INFURA_RPC_URL),
  });

  console.log('📡 Fetching token data from blockchain...');
  const contract = getContract({
    address: TOKEN_ADDRESS as `0x${string}`,
    abi: TOKEN_ABI,
    client: publicClient,
  });

  // Token məlumatlarını oxu
  const [name, symbol, evolutionMode, finalTargetWei, totalRaised, totalSupply, isFinalized] = await Promise.all([
    contract.read.name(),
    contract.read.symbol(),
    contract.read.evolutionMode(),
    contract.read.finalTargetWei(),
    contract.read.totalRaised(),
    contract.read.totalSupply(),
    contract.read.isFinalized(),
  ]);

  console.log(`\n📋 Token Information:`);
  console.log(`   Name: ${name}`);
  console.log(`   Symbol: ${symbol}`);
  console.log(`   Evolution Mode: ${evolutionMode}`);
  console.log(`   Final Target: ${finalTargetWei.toString()} wei`);
  console.log(`   Total Raised: ${totalRaised.toString()} wei`);
  console.log(`   Total Supply: ${totalSupply.toString()}`);
  console.log(`   Is Finalized: ${isFinalized}`);
  console.log(`\n💾 Inserting into database...`);

  // Database-ə əlavə et
  const result = await db`
    INSERT INTO projects (
      contract_address,
      creator_address,
      current_name,
      current_symbol,
      evolution_mode,
      final_target_wei,
      total_raised_wei,
      total_supply,
      is_finalized,
      chain_id,
      chain_name,
      evolution_status,
      created_at
    ) VALUES (
      ${TOKEN_ADDRESS.toLowerCase()},
      ${CREATOR_ADDRESS.toLowerCase()},
      ${name},
      ${symbol},
      ${evolutionMode.toLowerCase()},
      ${finalTargetWei.toString()},
      ${totalRaised.toString()},
      ${totalSupply.toString()},
      ${isFinalized},
      80002,
      'Polygon Amoy',
      'IDLE',
      NOW()
    )
    ON CONFLICT (contract_address) DO UPDATE SET
      current_name = EXCLUDED.current_name,
      current_symbol = EXCLUDED.current_symbol,
      total_raised_wei = EXCLUDED.total_raised_wei,
      is_finalized = EXCLUDED.is_finalized,
      updated_at = NOW()
    RETURNING *;
  `;

  console.log(`\n✅ Token successfully added to database!`);
  console.log(`   Contract Address: ${result[0].contract_address}`);
  console.log(`   Evolution Mode: ${result[0].evolution_mode}`);
  console.log(`\n🔗 View on frontend: https://lolhubfun.pages.dev/${TOKEN_ADDRESS.toLowerCase()}`);
}

main()
  .then(() => {
    console.log('\n✅ Script completed successfully!');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Script failed:', error);
    process.exit(1);
  });
