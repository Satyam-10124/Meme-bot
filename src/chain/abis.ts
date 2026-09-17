import { parseAbi } from 'viem';

/**
 * Minimal typed ABIs for the calls this bot makes. The full verified ABIs as pulled from
 * the explorer live in `abis/*.json` for reference; the curve and the launch token are not
 * verified, so their fragments below were reconstructed from the deployed bytecode's
 * selectors and cross-checked against settled transactions (see test/curve.test.ts).
 */

const TOKEN_PARAMS =
  '(string name, string symbol, string logo, string description, (string twitter, string telegram, string discord, string website, string farcaster) socials, address creatorFeeRecipient, uint16 creatorTaxBps, bool buybackEnabled, bytes32 expectedEconomics, bytes32 salt)';

const LAUNCH_CONFIG =
  '(uint256 supply, uint256 curveFeeBps, uint256 phantomQuote, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, bool enabled)';

const LAUNCHED_TOKEN =
  '(address token, address curve, address deployer, address creatorFeeRecipient, address pairToken, uint256 graduationThreshold, uint24 poolFee, int24 tickSpacing, uint16 creatorTaxBps, bool buybackEnabled, uint8 phase, uint256 sweptQuote, uint256 sweptTokens, uint256 sweptAt, bool exists)';

const FEE_POLICY =
  '(address protocolFeeRecipient, uint16 protocolFeeShareBps, uint16 buybackBurnBps, uint16 hookFeeBps, uint16 maxInternalPriceImpactBps)';

export const factoryAbi = parseAbi([
  'function launchFee() view returns (uint256)',
  'function launchEnabled() view returns (bool)',
  'function canLaunch(address launcher) view returns (bool)',
  'function maxCreatorTaxBps() view returns (uint256)',
  'function launchConfigCount() view returns (uint256)',
  `function getLaunchConfig(uint256 id) view returns (${LAUNCH_CONFIG})`,
  'function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)',
  `function getLaunchedToken(address token) view returns (${LAUNCHED_TOKEN})`,
  `function getLaunchFeePolicy(address token) view returns (${FEE_POLICY})`,
  'function feeEscrow() view returns (address)',
  'function memeHook() view returns (address)',
  'function snipeTaxStartBps() view returns (uint256)',
  'function snipeTaxSeconds() view returns (uint256)',
  'function CREATOR_FEE_RECIPIENT_TIMELOCK() view returns (uint256)',
  'function CREATOR_FEE_RECIPIENT_EXECUTION_WINDOW() view returns (uint256)',
  'function pendingCreatorFeeRecipient(address token) view returns (address recipient, uint256 effectiveAt, uint256 expiresAt)',
  'function transferCreatorFeeRecipient(address token, address newRecipient)',
  'function executeCreatorFeeRecipientChange(address token)',
  'function cancelCreatorFeeRecipientChange(address token)',
  'function createGraduatedPool(address token)',
  `function launchToken(${TOKEN_PARAMS} params, uint256 launchConfigId, address pairToken) payable returns (address token, address curve)`,
  'event TokenLaunched(address indexed token, address indexed curve, address indexed deployer, address pairToken, uint256 launchConfigId, uint256 graduationThreshold)',
  'event CreatorFeeRecipientUpdated(address indexed token, address indexed previousRecipient, address indexed newRecipient)',
  'event CreatorFeeRecipientChangeProposed(address indexed token, address indexed currentRecipient, address indexed proposedRecipient, uint256 effectiveAt, uint256 expiresAt)',
  'event PoolGraduated(address indexed token, uint256 positionId, uint256 tokenAmount, uint256 pairTokenAmount)',
]);

export const routerAbi = parseAbi([
  'function factory() view returns (address)',
  `function launchAndBuy(${TOKEN_PARAMS} params, uint256 launchConfigId, address pairToken, uint256 quoteIn, uint256 minTokensOut, address recipient, address[] exemptions) payable returns (address token, address curve, uint256 tokensOut)`,
]);

export const curveAbi = parseAbi([
  'function getReserves() view returns (uint256 quoteReserve, uint256 tokenReserve)',
  'function quoteReserve() view returns (uint256)',
  'function tokenReserve() view returns (uint256)',
  'function realQuoteReserve() view returns (uint256)',
  'function phantomQuote() view returns (uint256)',
  'function sellableTokens() view returns (uint256)',
  'function readyToGraduate() view returns (bool)',
  'function graduated() view returns (bool)',
  'function graduationThreshold() view returns (uint256)',
  'function launchSupply() view returns (uint256)',
  'function reservedTokens() view returns (uint256)',
  'function feeBps() view returns (uint16)',
  'function creatorTaxBps() view returns (uint16)',
  'function buybackEnabled() view returns (bool)',
  'function isNativeQuote() view returns (bool)',
  'function token() view returns (address)',
  'function quoteFeeBalance() view returns (uint256)',
  'function creatorTaxBalance() view returns (uint256)',
  'function currentSnipeTaxBps(address buyer) view returns (uint256)',
  'function snipeTaxExempt(address account) view returns (bool)',
  'function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256 tokensOut)',
  'function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256 quoteOut)',
  'function sweepFees(uint256 minBuybackTokensOut)',
  'event CurveBuy(address indexed buyer, address indexed recipient, uint256 quoteIn, uint256 tokensOut, uint256 feeAmount, uint256 creatorTax)',
  'event CurveSell(address indexed seller, address indexed recipient, uint256 tokensIn, uint256 quoteOut, uint256 feeAmount, uint256 creatorTax)',
  'event FeesSwept(uint256 protocolAmount, uint256 creatorAmount, uint256 buybackAmount)',
]);

export const escrowAbi = parseAbi([
  'function balanceOf(address recipient) view returns (uint256)',
  'function balanceOfToken(address recipient, address token) view returns (uint256)',
  'function claim() returns (uint256 amount)',
  'function claim(uint256 amount) returns (uint256)',
  'function claimToken(address token) returns (uint256 amount)',
  'function claimToken(address token, uint256 amount) returns (uint256)',
  'event Claimed(address indexed recipient, uint256 amount)',
  'event Credited(address indexed recipient, address indexed depositor, uint256 amount)',
]);

export const hookAbi = parseAbi([
  'function pendingFees(bytes32 poolId, address currency) view returns (uint256 amount)',
  'function pendingCreatorTax(bytes32 poolId, address currency) view returns (uint256 amount)',
  'function launches(bytes32 poolId) view returns (bool registered, bool memecoinIsCurrency0, address memecoin, address quoteToken, address creator, address buybackCreatorRecipient, address protocolFeeRecipient, uint16 creatorTaxBps, uint16 protocolFeeShareBps, uint16 buybackBurnBps, uint16 hookFeeBps, uint16 maxInternalPriceImpactBps, bool buybackEnabled)',
  'function sweepPoolFees(bytes32 poolId, uint256 minConversionOut, uint256 minBuybackOut)',
  'function setCreatorFeeRecipient(bytes32 poolId, address recipient)',
  'event PoolFeesSwept(bytes32 indexed poolId, uint256 protocolAmount, uint256 buybackAmount, uint256 creatorAmount, uint256 tokensLocked)',
]);

export const launchTokenAbi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function logo() view returns (string)',
  'function description() view returns (string)',
  'function curve() view returns (address)',
  'function launchFactory() view returns (address)',
  'function getTokenInfo() view returns (address deployer, string logo, string description, (string twitter, string telegram, string discord, string website, string farcaster) socials)',
]);

export const erc20Abi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);
