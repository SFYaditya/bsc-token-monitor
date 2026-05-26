export const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

export const FACTORY_ABI = [
  'event PairCreated(address indexed token0, address indexed token1, address pair, uint)',
  'function getPair(address tokenA, address tokenB) external view returns (address pair)',
];

export const RISK_SCAN_ABI = [
  'function owner() view returns (address)',
  'function getOwner() view returns (address)',
  'function isBlacklisted(address) view returns (bool)',
  'function tradingOpen() view returns (bool)',
  'function mint(address,uint256)',
];

export const STAKING_EVENT_ABI = [
  'event Staked(address indexed user, uint256 amount)',
  'event Withdrawn(address indexed user, uint256 amount)',
  'event RewardPaid(address indexed user, uint256 reward)',
];

/** 常见 MasterChef / StakingMaster 事件 */
export const MASTERCHEF_EVENT_ABI = [
  'event Deposit(address indexed user, uint256 indexed pid, uint256 amount)',
  'event Withdraw(address indexed user, uint256 indexed pid, uint256 amount)',
  'event EmergencyWithdraw(address indexed user, uint256 indexed pid, uint256 amount)',
  'event Harvest(address indexed user, uint256 indexed pid, uint256 amount)',
];

export const PAIR_ABI = [
  'event Swap(address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
  'event Mint(address indexed sender, uint256 amount0, uint256 amount1)',
  'event Burn(address indexed sender, uint256 amount0, uint256 amount1, address indexed to)',
  'event Sync(uint112 reserve0, uint112 reserve1)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
];
