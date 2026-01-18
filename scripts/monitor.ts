import { PositionMonitor } from '../src/monitor/positions';

async function main() {
    const monitor = new PositionMonitor();
    
    console.log('🔍 Starting monitoring of positions on Aave v3 (Arbitrum)...');
    console.log('⚙️ Configuration:');
    console.log(`   Min Health Factor: ${process.env.MIN_HEALTH_FACTOR || '1.1'}`);
    console.log(`   Min Profit USD: $${process.env.MIN_PROFIT_USD || '100'}`);
    
    const positions = await monitor.findLiquidatablePositions();
    
    if (positions.length > 0) {
        console.log(`\n✅ Found ${positions.length} liquidatable positions:`);
        positions.forEach(pos => {
            console.log(`
            👤 User: ${pos.user}
            ❤️ Health Factor: ${pos.healthFactor}
            💰 Estimated profit: $${pos.estimatedProfit.toFixed(2)}
            🏦 Total collateral: ${pos.totalCollateralETH.toFixed(4)} ETH
            💸 Total debt: ${pos.totalDebtETH.toFixed(4)} ETH
            🪙 Collateral asset: ${pos.collateralAsset}
            🎁 Liquidation bonus: ${pos.liquidationBonus?.toFixed(2)}%
            `);
        });
    } else {
        console.log('\n❌ No liquidatable positions found');
    }
}

main().catch(error => {
    console.error('Error in script:', error);
    process.exit(1);
}); 