// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";

import {ICollateralRegistry} from "./interfaces/ICollateralRegistry.sol";
import {IRateModel} from "./interfaces/IRateModel.sol";
import {IMeridianRateOracle} from "./interfaces/IMeridianRateOracle.sol";

/// @title RepoMarket
/// @notice Meridian's core engine: a fixed-term, overcollateralized repo
/// market where tokenized real-world assets are financed against a single
/// cash asset (a fiat-backed stablecoin, the market's unit of account).
///
/// Structure:
/// - Four term pools (overnight, 7d, 30d, 90d). Lenders supply cash to a
///   pool and hold pro-rata shares; idle cash is withdrawable at any time.
/// - Borrowers open repos: post registered collateral, draw cash at a rate
///   fixed at open for the whole term (bullet repayment, pro-rata interest
///   on early close).
/// - Repos are margin-maintained: a price drop below the maintenance
///   threshold, or passing maturity + grace, makes a repo liquidatable.
/// - Every action that moves a pool's utilization pushes the pool's marginal
///   rate to the MeridianRateOracle — the overnight print is MOR.
contract RepoMarket is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;

    // ---------------------------------------------------------------------
    // Constants & types
    // ---------------------------------------------------------------------

    uint256 internal constant BPS = 10_000;
    uint256 internal constant YEAR = 365 days;
    uint256 internal constant WAD = 1e18;
    // ERC-4626-style virtual shares offset to neutralize donation/inflation
    // attacks on empty pools.
    uint256 internal constant VIRTUAL_SHARES = 1e6;

    uint8 public constant TERM_OVERNIGHT = 0;
    uint8 public constant TERM_WEEKLY = 1;
    uint8 public constant TERM_MONTHLY = 2;
    uint8 public constant TERM_QUARTERLY = 3;
    uint8 public constant NUM_TERMS = 4;

    /// @notice Seconds past maturity before a repo is in default.
    uint256 public constant GRACE_PERIOD = 1 days;

    struct Pool {
        uint128 cash; // idle stable held by the pool
        uint128 principalOutstanding; // principal currently out in repos
        uint256 totalShares;
    }

    struct Repo {
        address borrower;
        address collateralToken;
        uint128 collateralAmount;
        uint128 principal; // stable base units
        uint64 rateBps; // annualized, fixed at open/roll
        uint40 openedAt;
        uint40 maturity;
        uint8 term;
        bool active;
    }

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    IERC20 public immutable stable;
    uint8 public immutable stableDecimals;

    ICollateralRegistry public registry;
    IRateModel public rateModel;
    IMeridianRateOracle public rateOracle;
    address public treasury;

    /// @notice Optional external ERC-4626 vault (an Aave wrapper, Morpho or
    /// similar already-deployed venue) where idle pool cash is parked. The
    /// market pushes cash in as it arrives and pulls it back on demand, so
    /// liquidity is never idle; yield on the float accrues to the treasury
    /// via {skim}. address(0) = hold cash locally.
    IERC4626 public reserveVault;

    /// @notice Share of repo interest kept by the protocol (bps).
    uint256 public protocolFeeBps;
    /// @notice Extra annualized rate charged past maturity (bps).
    uint256 public lateFeeBps;
    /// @notice Minimum repo principal, to keep dust out (stable base units).
    uint256 public minBorrow;

    Pool[NUM_TERMS] internal _pools;
    mapping(uint8 => mapping(address => uint256)) public sharesOf; // term => lender => shares
    mapping(uint256 => Repo) internal _repos;
    uint256 public nextRepoId;

    /// @notice Total units of each collateral token currently held, for
    /// enforcing registry supply caps.
    mapping(address => uint256) public collateralHeld;

    // ---------------------------------------------------------------------
    // Events & errors
    // ---------------------------------------------------------------------

    event Deposited(uint8 indexed term, address indexed lender, uint256 amount, uint256 shares);
    event Withdrawn(uint8 indexed term, address indexed lender, uint256 amount, uint256 shares);
    event RepoOpened(
        uint256 indexed repoId,
        address indexed borrower,
        uint8 indexed term,
        address collateralToken,
        uint256 collateralAmount,
        uint256 principal,
        uint256 rateBps,
        uint256 maturity
    );
    event RepoClosed(uint256 indexed repoId, uint256 principal, uint256 interest, uint256 protocolFee);
    event RepoRolled(uint256 indexed repoId, uint256 interestSettled, uint256 newRateBps, uint256 newMaturity);
    event RepoLiquidated(
        uint256 indexed repoId,
        address indexed liquidator,
        uint256 repaid,
        uint256 collateralSeized,
        uint256 badDebt
    );
    event ProtocolFeeSet(uint256 feeBps);
    event LateFeeSet(uint256 feeBps);
    event MinBorrowSet(uint256 amount);
    event TreasurySet(address treasury);
    event RateModelSet(address model);
    event RegistrySet(address registry);
    event RateOracleSet(address oracle);
    event ReserveVaultSet(address vault);
    event SurplusSkimmed(uint256 amount);

    error InvalidTerm();
    error ZeroAmount();
    error BelowMinBorrow();
    error InsufficientLiquidity();
    error InsufficientShares();
    error CollateralNotEnabled(address token);
    error SupplyCapExceeded(address token);
    error ExceedsAdvanceRate();
    error NotBorrower();
    error RepoNotActive();
    error RepoMatured();
    error NotLiquidatable();
    error RepoUnhealthy();
    error InvalidParams();

    // ---------------------------------------------------------------------
    // Setup
    // ---------------------------------------------------------------------

    constructor(
        address initialOwner,
        IERC20 stable_,
        ICollateralRegistry registry_,
        IRateModel rateModel_,
        IMeridianRateOracle rateOracle_,
        address treasury_
    ) Ownable(initialOwner) {
        if (
            address(stable_) == address(0) ||
            address(registry_) == address(0) ||
            address(rateModel_) == address(0) ||
            address(rateOracle_) == address(0) ||
            treasury_ == address(0)
        ) revert InvalidParams();
        stable = stable_;
        stableDecimals = IERC20Metadata(address(stable_)).decimals();
        registry = registry_;
        rateModel = rateModel_;
        rateOracle = rateOracle_;
        treasury = treasury_;
        protocolFeeBps = 1000; // 10% of interest
        lateFeeBps = 500; // +5% annualized past maturity
        minBorrow = 10 ** IERC20Metadata(address(stable_)).decimals(); // 1 unit
    }

    // ---------------------------------------------------------------------
    // Lender side
    // ---------------------------------------------------------------------

    /// @notice Supply cash to a term pool; receive pro-rata shares.
    function deposit(uint8 term, uint256 amount) external nonReentrant whenNotPaused returns (uint256 shares) {
        _checkTerm(term);
        if (amount == 0) revert ZeroAmount();
        Pool storage pool = _pools[term];

        shares = _toShares(pool, amount, Math.Rounding.Floor);
        pool.cash += amount.toUint128();
        pool.totalShares += shares;
        sharesOf[term][msg.sender] += shares;

        stable.safeTransferFrom(msg.sender, address(this), amount);
        _pushCash(amount);
        _pushRate(term);
        emit Deposited(term, msg.sender, amount, shares);
    }

    /// @notice Redeem shares for cash. Only idle cash can leave; principal
    /// out in repos returns as repos close or liquidate.
    function withdraw(uint8 term, uint256 shares) external nonReentrant returns (uint256 amount) {
        _checkTerm(term);
        if (shares == 0) revert ZeroAmount();
        Pool storage pool = _pools[term];
        if (shares > sharesOf[term][msg.sender]) revert InsufficientShares();

        amount = _toAssets(pool, shares, Math.Rounding.Floor);
        if (amount > pool.cash) revert InsufficientLiquidity();

        sharesOf[term][msg.sender] -= shares;
        pool.totalShares -= shares;
        pool.cash -= amount.toUint128();

        _pullCash(amount);
        stable.safeTransfer(msg.sender, amount);
        _pushRate(term);
        emit Withdrawn(term, msg.sender, amount, shares);
    }

    // ---------------------------------------------------------------------
    // Borrower side
    // ---------------------------------------------------------------------

    /// @notice Open a fixed-term repo: post collateral, draw cash. The rate
    /// is the pool's marginal rate at post-borrow utilization, locked for
    /// the term.
    function openRepo(
        uint8 term,
        address collateralToken,
        uint256 collateralAmount,
        uint256 borrowAmount
    ) external nonReentrant whenNotPaused returns (uint256 repoId) {
        _checkTerm(term);
        if (collateralAmount == 0) revert ZeroAmount();
        if (borrowAmount < minBorrow) revert BelowMinBorrow();

        if (!registry.isEnabled(collateralToken)) revert CollateralNotEnabled(collateralToken);
        ICollateralRegistry.CollateralConfig memory cfg = registry.getConfig(collateralToken);

        uint256 newHeld = collateralHeld[collateralToken] + collateralAmount;
        if (cfg.supplyCap != 0 && newHeld > cfg.supplyCap) revert SupplyCapExceeded(collateralToken);

        // Advance-rate check: borrow value may not exceed the haircut value
        // of the collateral.
        uint256 collateralValue = _collateralValueInStable(collateralToken, collateralAmount);
        if (borrowAmount > (collateralValue * cfg.advanceRateBps) / BPS) revert ExceedsAdvanceRate();

        Pool storage pool = _pools[term];
        if (borrowAmount > pool.cash) revert InsufficientLiquidity();

        pool.cash -= borrowAmount.toUint128();
        pool.principalOutstanding += borrowAmount.toUint128();
        collateralHeld[collateralToken] = newHeld;

        uint256 rateBps = rateModel.rateFor(term, _utilizationBps(pool));
        uint256 maturity = block.timestamp + termDuration(term);

        repoId = nextRepoId++;
        _repos[repoId] = Repo({
            borrower: msg.sender,
            collateralToken: collateralToken,
            collateralAmount: collateralAmount.toUint128(),
            principal: borrowAmount.toUint128(),
            rateBps: uint64(rateBps),
            openedAt: uint40(block.timestamp),
            maturity: uint40(maturity),
            term: term,
            active: true
        });

        IERC20(collateralToken).safeTransferFrom(msg.sender, address(this), collateralAmount);
        _pullCash(borrowAmount);
        stable.safeTransfer(msg.sender, borrowAmount);
        _pushRate(term);

        emit RepoOpened(
            repoId,
            msg.sender,
            term,
            collateralToken,
            collateralAmount,
            borrowAmount,
            rateBps,
            maturity
        );
    }

    /// @notice Repay a repo in full (anyone may repay on a borrower's
    /// behalf; collateral always returns to the borrower).
    function closeRepo(uint256 repoId) external nonReentrant {
        Repo storage repo = _repos[repoId];
        if (!repo.active) revert RepoNotActive();

        uint256 interest = accruedInterest(repoId);
        uint256 principal = repo.principal;
        uint256 fee = (interest * protocolFeeBps) / BPS;

        repo.active = false;
        Pool storage pool = _pools[repo.term];
        pool.principalOutstanding -= principal.toUint128();
        pool.cash += (principal + interest - fee).toUint128();
        collateralHeld[repo.collateralToken] -= repo.collateralAmount;

        stable.safeTransferFrom(msg.sender, address(this), principal + interest);
        if (fee > 0) stable.safeTransfer(treasury, fee);
        _pushCash(principal + interest - fee);
        IERC20(repo.collateralToken).safeTransfer(repo.borrower, repo.collateralAmount);
        _pushRate(repo.term);

        emit RepoClosed(repoId, principal, interest, fee);
    }

    /// @notice Settle accrued interest and re-lock the repo at the current
    /// marginal rate for a fresh term. Only a healthy, unmatured repo rolls.
    function rollRepo(uint256 repoId) external nonReentrant whenNotPaused {
        Repo storage repo = _repos[repoId];
        if (!repo.active) revert RepoNotActive();
        if (msg.sender != repo.borrower) revert NotBorrower();
        if (block.timestamp >= repo.maturity) revert RepoMatured();
        if (_isMarginBreached(repo)) revert RepoUnhealthy();

        uint256 interest = accruedInterest(repoId);
        uint256 fee = (interest * protocolFeeBps) / BPS;

        Pool storage pool = _pools[repo.term];
        pool.cash += (interest - fee).toUint128();

        uint256 newRate = rateModel.rateFor(repo.term, _utilizationBps(pool));
        repo.rateBps = uint64(newRate);
        repo.openedAt = uint40(block.timestamp);
        repo.maturity = uint40(block.timestamp + termDuration(repo.term));

        stable.safeTransferFrom(msg.sender, address(this), interest);
        if (fee > 0) stable.safeTransfer(treasury, fee);
        _pushCash(interest - fee);
        _pushRate(repo.term);

        emit RepoRolled(repoId, interest, newRate, repo.maturity);
    }

    // ---------------------------------------------------------------------
    // Liquidation
    // ---------------------------------------------------------------------

    /// @notice True if the repo can be liquidated: maintenance margin is
    /// breached, or the repo is past maturity + grace.
    function isLiquidatable(uint256 repoId) public view returns (bool) {
        Repo storage repo = _repos[repoId];
        if (!repo.active) return false;
        if (block.timestamp > uint256(repo.maturity) + GRACE_PERIOD) return true;
        return _isMarginBreached(repo);
    }

    /// @notice Liquidate a defaulted or undermargined repo. The liquidator
    /// covers the debt and receives collateral worth debt * (1 + penalty).
    /// If collateral can't cover that, the liquidator takes all collateral
    /// at the penalty discount and the pool absorbs the shortfall.
    function liquidate(uint256 repoId) external nonReentrant {
        Repo storage repo = _repos[repoId];
        if (!repo.active) revert RepoNotActive();
        if (!isLiquidatable(repoId)) revert NotLiquidatable();

        ICollateralRegistry.CollateralConfig memory cfg = registry.getConfig(repo.collateralToken);
        uint256 debt = repo.principal + accruedInterest(repoId);
        uint256 collateralValue = _collateralValueInStable(repo.collateralToken, repo.collateralAmount);

        uint256 seizeValue = (debt * (BPS + cfg.liquidationPenaltyBps)) / BPS;
        uint256 repaid;
        uint256 seized;
        uint256 badDebt;

        if (collateralValue >= seizeValue) {
            // Full liquidation: debt covered, borrower keeps the remainder.
            repaid = debt;
            seized = (uint256(repo.collateralAmount) * seizeValue) / collateralValue;
        } else {
            // Underwater: all collateral goes at the same discount; the
            // shortfall is written down against the pool.
            repaid = (collateralValue * BPS) / (BPS + cfg.liquidationPenaltyBps);
            seized = repo.collateralAmount;
            badDebt = debt - repaid;
        }

        uint256 principal = repo.principal;
        repo.active = false;
        Pool storage pool = _pools[repo.term];
        pool.principalOutstanding -= principal.toUint128();

        // The protocol only takes its cut of interest when the pool is made
        // whole; in a bad-debt event everything recovered goes to the pool.
        uint256 fee;
        if (badDebt == 0 && repaid > principal) {
            uint256 interest = repaid - principal;
            fee = (interest * protocolFeeBps) / BPS;
        }
        pool.cash += (repaid - fee).toUint128();

        collateralHeld[repo.collateralToken] -= repo.collateralAmount;

        stable.safeTransferFrom(msg.sender, address(this), repaid);
        if (fee > 0) stable.safeTransfer(treasury, fee);
        _pushCash(repaid - fee);
        IERC20(repo.collateralToken).safeTransfer(msg.sender, seized);
        uint256 remainder = uint256(repo.collateralAmount) - seized;
        if (remainder > 0) IERC20(repo.collateralToken).safeTransfer(repo.borrower, remainder);
        _pushRate(repo.term);

        emit RepoLiquidated(repoId, msg.sender, repaid, seized, badDebt);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function termDuration(uint8 term) public pure returns (uint256) {
        if (term == TERM_OVERNIGHT) return 1 days;
        if (term == TERM_WEEKLY) return 7 days;
        if (term == TERM_MONTHLY) return 30 days;
        if (term == TERM_QUARTERLY) return 90 days;
        revert InvalidTerm();
    }

    function getRepo(uint256 repoId) external view returns (Repo memory) {
        return _repos[repoId];
    }

    function getPool(uint8 term)
        external
        view
        returns (uint256 cash, uint256 principalOutstanding, uint256 totalShares, uint256 utilizationBps)
    {
        _checkTerm(term);
        Pool storage pool = _pools[term];
        return (pool.cash, pool.principalOutstanding, pool.totalShares, _utilizationBps(pool));
    }

    /// @notice Cash value of a lender's shares in a term pool.
    function balanceOfAssets(uint8 term, address lender) external view returns (uint256) {
        _checkTerm(term);
        return _toAssets(_pools[term], sharesOf[term][lender], Math.Rounding.Floor);
    }

    /// @notice Interest accrued on a repo so far: pro-rata to the fixed rate
    /// within the term, plus the late-fee rate past maturity.
    function accruedInterest(uint256 repoId) public view returns (uint256) {
        Repo storage repo = _repos[repoId];
        if (!repo.active) return 0;

        uint256 elapsed = block.timestamp - repo.openedAt;
        uint256 term = uint256(repo.maturity) - repo.openedAt;
        uint256 inTerm = elapsed < term ? elapsed : term;
        uint256 interest = (uint256(repo.principal) * repo.rateBps * inTerm) / (YEAR * BPS);

        if (block.timestamp > repo.maturity) {
            uint256 late = block.timestamp - repo.maturity;
            interest += (uint256(repo.principal) * (repo.rateBps + lateFeeBps) * late) / (YEAR * BPS);
        }
        return interest;
    }

    /// @notice Current debt (principal + accrued interest) of a repo.
    function currentDebt(uint256 repoId) external view returns (uint256) {
        Repo storage repo = _repos[repoId];
        return repo.active ? repo.principal + accruedInterest(repoId) : 0;
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setProtocolFee(uint256 feeBps) external onlyOwner {
        if (feeBps > 2000) revert InvalidParams(); // hard cap: 20% of interest
        protocolFeeBps = feeBps;
        emit ProtocolFeeSet(feeBps);
    }

    function setLateFee(uint256 feeBps) external onlyOwner {
        if (feeBps > 5000) revert InvalidParams();
        lateFeeBps = feeBps;
        emit LateFeeSet(feeBps);
    }

    function setMinBorrow(uint256 amount) external onlyOwner {
        minBorrow = amount;
        emit MinBorrowSet(amount);
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert InvalidParams();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function setRateModel(IRateModel model) external onlyOwner {
        if (address(model) == address(0)) revert InvalidParams();
        rateModel = model;
        emit RateModelSet(address(model));
    }

    function setRegistry(ICollateralRegistry registry_) external onlyOwner {
        if (address(registry_) == address(0)) revert InvalidParams();
        registry = registry_;
        emit RegistrySet(address(registry_));
    }

    function setRateOracle(IMeridianRateOracle oracle) external onlyOwner {
        if (address(oracle) == address(0)) revert InvalidParams();
        rateOracle = oracle;
        emit RateOracleSet(address(oracle));
    }

    /// @notice Point idle cash at an external ERC-4626 venue (or address(0)
    /// to hold cash locally). Fully unwinds the old vault, then parks the
    /// market's whole cash balance in the new one.
    function setReserveVault(IERC4626 newVault) external onlyOwner nonReentrant {
        IERC4626 old = reserveVault;
        if (address(old) != address(0)) {
            uint256 shares = old.balanceOf(address(this));
            if (shares > 0) old.redeem(shares, address(this), address(this));
        }
        if (address(newVault) != address(0) && newVault.asset() != address(stable)) revert InvalidParams();
        reserveVault = newVault;

        if (address(newVault) != address(0)) {
            uint256 bal = stable.balanceOf(address(this));
            if (bal > 0) {
                stable.forceApprove(address(newVault), bal);
                newVault.deposit(bal, address(this));
            }
        }
        emit ReserveVaultSet(address(newVault));
    }

    /// @notice Sends yield earned on the parked float (anything held beyond
    /// what lenders are owed) to the treasury. Callable by anyone.
    function skim() external nonReentrant returns (uint256 surplus) {
        uint256 tracked = _totalTrackedCash();
        uint256 local = stable.balanceOf(address(this));
        uint256 inVault = address(reserveVault) != address(0)
            ? reserveVault.convertToAssets(reserveVault.balanceOf(address(this)))
            : 0;
        uint256 held = local + inVault;
        if (held > tracked) {
            surplus = held - tracked;
            uint256 fromVault = surplus > local ? surplus - local : 0;
            if (fromVault > 0) reserveVault.withdraw(fromVault, address(this), address(this));
            stable.safeTransfer(treasury, surplus);
        }
        emit SurplusSkimmed(surplus);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _checkTerm(uint8 term) internal pure {
        if (term >= NUM_TERMS) revert InvalidTerm();
    }

    function _totalAssets(Pool storage pool) internal view returns (uint256) {
        return uint256(pool.cash) + pool.principalOutstanding;
    }

    function _toShares(Pool storage pool, uint256 assets, Math.Rounding rounding) internal view returns (uint256) {
        return Math.mulDiv(assets, pool.totalShares + VIRTUAL_SHARES, _totalAssets(pool) + 1, rounding);
    }

    function _toAssets(Pool storage pool, uint256 shares, Math.Rounding rounding) internal view returns (uint256) {
        return Math.mulDiv(shares, _totalAssets(pool) + 1, pool.totalShares + VIRTUAL_SHARES, rounding);
    }

    function _utilizationBps(Pool storage pool) internal view returns (uint256) {
        uint256 total = _totalAssets(pool);
        if (total == 0) return 0;
        return (uint256(pool.principalOutstanding) * BPS) / total;
    }

    /// @dev Collateral USD value converted into stable base units. The
    /// stablecoin is the market's unit of account and is treated as $1.
    function _collateralValueInStable(address token, uint256 amount) internal view returns (uint256) {
        uint256 usdWad = registry.usdValueOf(token, amount);
        return (usdWad * (10 ** stableDecimals)) / WAD;
    }

    function _isMarginBreached(Repo storage repo) internal view returns (bool) {
        ICollateralRegistry.CollateralConfig memory cfg = registry.getConfig(repo.collateralToken);
        uint256 collateralValue = _collateralValueInStable(repo.collateralToken, repo.collateralAmount);
        uint256 debt = repo.principal +
            (uint256(repo.principal) * repo.rateBps * (block.timestamp - repo.openedAt)) /
            (YEAR * BPS);
        return debt > (collateralValue * cfg.maintenanceRateBps) / BPS;
    }

    function _pushRate(uint8 term) internal {
        rateOracle.record(term, rateModel.rateFor(term, _utilizationBps(_pools[term])));
    }

    function _totalTrackedCash() internal view returns (uint256 total) {
        for (uint8 i; i < NUM_TERMS; i++) {
            total += _pools[i].cash;
        }
    }

    /// @dev Park newly received cash in the reserve vault, if one is set.
    function _pushCash(uint256 amount) internal {
        IERC4626 vault = reserveVault;
        if (address(vault) != address(0) && amount > 0) {
            stable.forceApprove(address(vault), amount);
            vault.deposit(amount, address(this));
        }
    }

    /// @dev Recall cash from the reserve vault ahead of a payout.
    function _pullCash(uint256 amount) internal {
        IERC4626 vault = reserveVault;
        if (address(vault) != address(0) && amount > 0) {
            vault.withdraw(amount, address(this), address(this));
        }
    }
}
