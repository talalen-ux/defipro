// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockERC20} from "../mocks/MockERC20.sol";

/// @title Faucet (testnet only)
/// @notice Self-serve onboarding for the MVP: anyone can claim a starter
/// balance of the reserve stablecoin and both demo collateral tokens once
/// per cooldown, so trying the full faucet → mint mUSD → lend / borrow
/// loop requires nothing but gas.
contract Faucet {
    uint256 public constant COOLDOWN = 1 days;

    MockERC20 public immutable usdc;
    MockERC20 public immutable tbill;
    MockERC20 public immutable tcred;

    uint256 public immutable usdcAmount;
    uint256 public immutable tbillAmount;
    uint256 public immutable tcredAmount;

    mapping(address => uint256) public lastClaim;

    event Claimed(address indexed user);

    error CooldownActive(uint256 availableAt);

    constructor(
        MockERC20 usdc_,
        MockERC20 tbill_,
        MockERC20 tcred_,
        uint256 usdcAmount_,
        uint256 tbillAmount_,
        uint256 tcredAmount_
    ) {
        usdc = usdc_;
        tbill = tbill_;
        tcred = tcred_;
        usdcAmount = usdcAmount_;
        tbillAmount = tbillAmount_;
        tcredAmount = tcredAmount_;
    }

    function claim() external {
        uint256 availableAt = lastClaim[msg.sender] + COOLDOWN;
        if (block.timestamp < availableAt) revert CooldownActive(availableAt);
        lastClaim[msg.sender] = block.timestamp;

        usdc.mint(msg.sender, usdcAmount);
        tbill.mint(msg.sender, tbillAmount);
        tcred.mint(msg.sender, tcredAmount);
        emit Claimed(msg.sender);
    }

    function nextClaimAt(address user) external view returns (uint256) {
        return lastClaim[user] + COOLDOWN;
    }
}
