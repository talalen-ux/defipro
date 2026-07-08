// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IRateModel} from "./interfaces/IRateModel.sol";

/// @title KinkedRateModel
/// @notice Per-term kinked utilization curve, the standard money-market
/// shape: rates climb gently up to the kink, then steeply, so the last unit
/// of pool liquidity is always priced. The overnight term's output is what
/// the MeridianRateOracle publishes as MOR.
contract KinkedRateModel is IRateModel, Ownable2Step {
    uint256 internal constant BPS = 10_000;

    struct RateParams {
        uint64 baseRateBps; // rate at 0% utilization (annualized bps)
        uint64 slope1Bps; // added rate from 0 -> kink
        uint64 slope2Bps; // added rate from kink -> 100%
        uint64 kinkBps; // utilization where the curve steepens
    }

    mapping(uint8 => RateParams) public params;

    event RateParamsSet(uint8 indexed term, uint64 baseRateBps, uint64 slope1Bps, uint64 slope2Bps, uint64 kinkBps);

    error InvalidParams();
    error ParamsNotSet(uint8 term);
    error InvalidUtilization();

    constructor(address initialOwner) Ownable(initialOwner) {}

    function setParams(uint8 term, RateParams calldata p) external onlyOwner {
        if (p.kinkBps == 0 || p.kinkBps >= BPS) revert InvalidParams();
        params[term] = p;
        emit RateParamsSet(term, p.baseRateBps, p.slope1Bps, p.slope2Bps, p.kinkBps);
    }

    /// @inheritdoc IRateModel
    function rateFor(uint8 term, uint256 utilizationBps) external view returns (uint256 rateBps) {
        if (utilizationBps > BPS) revert InvalidUtilization();
        RateParams memory p = params[term];
        if (p.kinkBps == 0) revert ParamsNotSet(term);

        if (utilizationBps <= p.kinkBps) {
            rateBps = p.baseRateBps + (uint256(p.slope1Bps) * utilizationBps) / p.kinkBps;
        } else {
            rateBps =
                p.baseRateBps +
                p.slope1Bps +
                (uint256(p.slope2Bps) * (utilizationBps - p.kinkBps)) /
                (BPS - p.kinkBps);
        }
    }
}
