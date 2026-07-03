// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {ICollateralRegistry} from "./interfaces/ICollateralRegistry.sol";
import {IPriceFeed} from "./interfaces/IPriceFeed.sol";

/// @title CollateralRegistry
/// @notice Governance-managed list of tokenized assets accepted as repo
/// collateral, with per-issuer risk parameters (advance rate / haircut,
/// maintenance margin, liquidation penalty, supply cap) and price feeds.
contract CollateralRegistry is ICollateralRegistry, Ownable2Step {
    uint256 internal constant BPS = 10_000;

    mapping(address => CollateralConfig) internal _configs;

    event CollateralSet(
        address indexed token,
        bool enabled,
        uint16 advanceRateBps,
        uint16 maintenanceRateBps,
        uint16 liquidationPenaltyBps,
        uint64 maxStaleness,
        address priceFeed,
        uint256 supplyCap
    );

    error NotListed(address token);
    error StalePrice(address token);
    error InvalidPrice(address token);
    error InvalidParams();

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice List a collateral token or update its risk parameters.
    /// @dev Requires 0 < advanceRate < maintenanceRate <= 100%.
    function setCollateral(
        address token,
        bool enabled,
        uint16 advanceRateBps,
        uint16 maintenanceRateBps,
        uint16 liquidationPenaltyBps,
        uint64 maxStaleness,
        address priceFeed,
        uint256 supplyCap
    ) external onlyOwner {
        if (
            token == address(0) ||
            priceFeed == address(0) ||
            advanceRateBps == 0 ||
            advanceRateBps >= maintenanceRateBps ||
            maintenanceRateBps > BPS ||
            liquidationPenaltyBps > BPS ||
            maxStaleness == 0
        ) revert InvalidParams();

        _configs[token] = CollateralConfig({
            enabled: enabled,
            decimals: IERC20Metadata(token).decimals(),
            advanceRateBps: advanceRateBps,
            maintenanceRateBps: maintenanceRateBps,
            liquidationPenaltyBps: liquidationPenaltyBps,
            maxStaleness: maxStaleness,
            priceFeed: priceFeed,
            supplyCap: supplyCap
        });

        emit CollateralSet(
            token,
            enabled,
            advanceRateBps,
            maintenanceRateBps,
            liquidationPenaltyBps,
            maxStaleness,
            priceFeed,
            supplyCap
        );
    }

    function setEnabled(address token, bool enabled) external onlyOwner {
        CollateralConfig storage cfg = _configs[token];
        if (cfg.priceFeed == address(0)) revert NotListed(token);
        cfg.enabled = enabled;
        emit CollateralSet(
            token,
            enabled,
            cfg.advanceRateBps,
            cfg.maintenanceRateBps,
            cfg.liquidationPenaltyBps,
            cfg.maxStaleness,
            cfg.priceFeed,
            cfg.supplyCap
        );
    }

    function getConfig(address token) external view returns (CollateralConfig memory) {
        return _configs[token];
    }

    function isEnabled(address token) external view returns (bool) {
        return _configs[token].enabled;
    }

    /// @inheritdoc ICollateralRegistry
    function usdValueOf(address token, uint256 amount) public view returns (uint256 usdWad) {
        CollateralConfig storage cfg = _configs[token];
        if (cfg.priceFeed == address(0)) revert NotListed(token);
        (uint256 priceWad, uint256 updatedAt) = IPriceFeed(cfg.priceFeed).latestPrice();
        if (priceWad == 0) revert InvalidPrice(token);
        if (block.timestamp > updatedAt + cfg.maxStaleness) revert StalePrice(token);
        usdWad = (amount * priceWad) / (10 ** cfg.decimals);
    }
}
