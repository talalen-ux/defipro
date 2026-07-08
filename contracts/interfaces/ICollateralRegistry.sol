// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

interface ICollateralRegistry {
    struct CollateralConfig {
        bool enabled;
        uint8 decimals;
        // Max borrow value as a fraction of collateral value at open (bps).
        // Repo-market convention: a 2% haircut == 9800 advance rate.
        uint16 advanceRateBps;
        // Margin-call threshold (bps). A repo is liquidatable when
        // debt > collateralValue * maintenanceRateBps / 1e4.
        uint16 maintenanceRateBps;
        // Bonus paid to the liquidator on top of the debt they cover (bps).
        uint16 liquidationPenaltyBps;
        // Max age of a price before it is considered stale (seconds).
        uint64 maxStaleness;
        address priceFeed;
        // Protocol-wide cap on units of this collateral (base units).
        uint256 supplyCap;
    }

    function getConfig(address token) external view returns (CollateralConfig memory);

    function isEnabled(address token) external view returns (bool);

    /// @notice USD value (1e18-scaled) of `amount` base units of `token`.
    /// Reverts if the token is unlisted or its price is stale.
    function usdValueOf(address token, uint256 amount) external view returns (uint256 usdWad);
}
