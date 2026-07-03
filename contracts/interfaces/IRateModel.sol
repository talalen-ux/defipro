// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

interface IRateModel {
    /// @notice Annualized borrow rate (bps) for a term pool at a given
    /// utilization (bps, 0..10000).
    function rateFor(uint8 term, uint256 utilizationBps) external view returns (uint256 rateBps);
}
