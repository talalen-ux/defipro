// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IPriceFeed} from "../interfaces/IPriceFeed.sol";

contract MockPriceFeed is IPriceFeed {
    uint256 public priceWad;
    uint256 public updatedAt;

    constructor(uint256 priceWad_) {
        priceWad = priceWad_;
        updatedAt = block.timestamp;
    }

    function setPrice(uint256 priceWad_) external {
        priceWad = priceWad_;
        updatedAt = block.timestamp;
    }

    /// @dev For staleness tests.
    function setUpdatedAt(uint256 ts) external {
        updatedAt = ts;
    }

    function latestPrice() external view returns (uint256, uint256) {
        return (priceWad, updatedAt);
    }
}
