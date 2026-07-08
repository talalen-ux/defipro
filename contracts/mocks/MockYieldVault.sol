// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Local stand-in for an already-deployed ERC-4626 yield venue
/// (an Aave stataToken, Morpho or Yearn vault). Yield is simulated in
/// tests by transferring extra asset tokens into the vault.
contract MockYieldVault is ERC4626 {
    constructor(IERC20 asset_) ERC20("Mock Yield Vault USDC", "myUSDC") ERC4626(asset_) {}
}
