import { ethers } from 'ethers';
import { PositionMonitor } from './monitor/positions';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

async function main() {
    try {
        // Setup provider and wallet
        const provider = new ethers.JsonRpcProvider(process.env.ARBITRUM_RPC_URL);
        const wallet = new ethers.Wallet(process.env.PRIVATE_KEY || '', provider);

        console.log('🚀 Starting Aave liquidation bot');
        console.log('Bot address:', wallet.address);

        // Start position monitor
        const monitor = new PositionMonitor();
        
        // Start monitoring every 10 minutes
        await monitor.startMonitoring(600000);

    } catch (error) {
        console.error('Bot error:', error);
        process.exit(1);
    }
}

main(); 