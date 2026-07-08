// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {RepoMarket} from "./RepoMarket.sol";

/// @title ProtocolTreasury
/// @notice On-chain destination for protocol fees, and the bootstrap
/// lender: governance can deploy treasury cash into the repo market's term
/// pools as protocol-owned liquidity, so the market quotes rates from day
/// one instead of waiting for outside lenders.
contract ProtocolTreasury is Ownable2Step {
    using SafeERC20 for IERC20;

    event PoolSeeded(address indexed market, uint8 indexed term, uint256 amount, uint256 shares);
    event PoolExited(address indexed market, uint8 indexed term, uint256 shares, uint256 amount);
    event Swept(address indexed token, address indexed to, uint256 amount);

    error InvalidParams();

    constructor(address initialOwner) Ownable(initialOwner) {}

    /// @notice Lend treasury cash into a term pool (protocol-owned liquidity).
    function seedPool(RepoMarket market, uint8 term, uint256 amount) external onlyOwner returns (uint256 shares) {
        IERC20 cash = market.stable();
        cash.forceApprove(address(market), amount);
        shares = market.deposit(term, amount);
        emit PoolSeeded(address(market), term, amount, shares);
    }

    /// @notice Withdraw protocol-owned liquidity back to the treasury.
    function exitPool(RepoMarket market, uint8 term, uint256 shares) external onlyOwner returns (uint256 amount) {
        amount = market.withdraw(term, shares);
        emit PoolExited(address(market), term, shares, amount);
    }

    /// @notice Move treasury funds (fee income, exited liquidity) elsewhere.
    function sweep(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert InvalidParams();
        token.safeTransfer(to, amount);
        emit Swept(address(token), to, amount);
    }
}
