// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.24;

interface IMeridianRateOracle {
    function record(uint8 term, uint256 rateBps) external;

    function currentRate(uint8 term) external view returns (uint256 rateBps, uint256 updatedAt);

    /// @notice Time-weighted average rate (bps) over the trailing `window`
    /// seconds. The window is clamped to available history.
    function twar(uint8 term, uint256 window) external view returns (uint256 rateBps);
}
