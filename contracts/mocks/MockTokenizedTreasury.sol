// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {MockERC20} from "./MockERC20.sol";

/// @notice Stand-in for a tokenized treasury fund share (a BUIDL/BENJI-style
/// token). Carries issuer metadata and a redemption delay to mirror the
/// settlement-lag problem Meridian's repo facility exists to solve.
contract MockTokenizedTreasury is MockERC20 {
    address public immutable issuer;
    uint256 public immutable redemptionDelay; // seconds from request to cash

    constructor(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        address issuer_,
        uint256 redemptionDelay_
    ) MockERC20(name_, symbol_, decimals_) {
        issuer = issuer_;
        redemptionDelay = redemptionDelay_;
    }
}
