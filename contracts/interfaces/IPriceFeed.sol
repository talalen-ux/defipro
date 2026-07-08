// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

/// @notice Minimal price feed interface. Returns the USD price of one whole
/// token (i.e. 10**decimals base units), scaled to 1e18.
interface IPriceFeed {
    function latestPrice() external view returns (uint256 priceWad, uint256 updatedAt);
}
