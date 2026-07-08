// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.24;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IMeridianRateOracle} from "./interfaces/IMeridianRateOracle.sol";

/// @title MeridianRateOracle
/// @notice On-chain benchmark rate publisher. The RepoMarket pushes the
/// marginal clearing rate of each term pool on every state change; this
/// contract maintains a cumulative rate-time accumulator per term (the same
/// technique as a price TWAP) so anyone can read a manipulation-resistant
/// time-weighted average rate (TWAR). The overnight term's TWAR is MOR —
/// the Meridian Overnight Rate.
contract MeridianRateOracle is IMeridianRateOracle, Ownable2Step {
    struct Observation {
        uint40 timestamp;
        uint216 cumulative; // sum of rateBps * seconds up to `timestamp`
    }

    struct TermState {
        uint256 lastRate; // bps
        uint40 lastUpdate;
        uint216 cumulative;
        Observation[] observations;
    }

    address public market;
    mapping(uint8 => TermState) internal _terms;

    event MarketSet(address indexed market);
    event RateRecorded(uint8 indexed term, uint256 rateBps, uint256 cumulative);

    error OnlyMarket();
    error NoHistory(uint8 term);
    error ZeroWindow();

    constructor(address initialOwner) Ownable(initialOwner) {}

    function setMarket(address market_) external onlyOwner {
        market = market_;
        emit MarketSet(market_);
    }

    /// @inheritdoc IMeridianRateOracle
    function record(uint8 term, uint256 rateBps) external {
        if (msg.sender != market) revert OnlyMarket();
        TermState storage t = _terms[term];

        if (t.lastUpdate != 0) {
            t.cumulative += uint216(t.lastRate * (block.timestamp - t.lastUpdate));
        }
        t.lastRate = rateBps;
        t.lastUpdate = uint40(block.timestamp);

        Observation[] storage obs = t.observations;
        // One observation per timestamp: overwrite if same second.
        if (obs.length > 0 && obs[obs.length - 1].timestamp == block.timestamp) {
            obs[obs.length - 1].cumulative = t.cumulative;
        } else {
            obs.push(Observation({timestamp: uint40(block.timestamp), cumulative: t.cumulative}));
        }
        emit RateRecorded(term, rateBps, t.cumulative);
    }

    /// @inheritdoc IMeridianRateOracle
    function currentRate(uint8 term) external view returns (uint256 rateBps, uint256 updatedAt) {
        TermState storage t = _terms[term];
        if (t.lastUpdate == 0) revert NoHistory(term);
        return (t.lastRate, t.lastUpdate);
    }

    /// @inheritdoc IMeridianRateOracle
    function twar(uint8 term, uint256 window) external view returns (uint256 rateBps) {
        if (window == 0) revert ZeroWindow();
        TermState storage t = _terms[term];
        Observation[] storage obs = t.observations;
        if (obs.length == 0) revert NoHistory(term);

        uint256 cumNow = uint256(t.cumulative) + t.lastRate * (block.timestamp - t.lastUpdate);

        uint256 target = block.timestamp > window ? block.timestamp - window : 0;
        uint256 firstTs = obs[0].timestamp;
        if (target < firstTs) target = firstTs; // clamp to available history

        uint256 elapsed = block.timestamp - target;
        if (elapsed == 0) return t.lastRate;

        uint256 cumThen = _cumulativeAt(t, target);
        return (cumNow - cumThen) / elapsed;
    }

    function observationCount(uint8 term) external view returns (uint256) {
        return _terms[term].observations.length;
    }

    /// @dev Cumulative rate-time at `target`, interpolating from the latest
    /// observation at or before `target` using the rate that was live then.
    function _cumulativeAt(TermState storage t, uint256 target) internal view returns (uint256) {
        Observation[] storage obs = t.observations;

        // Binary search for the last observation with timestamp <= target.
        uint256 lo = 0;
        uint256 hi = obs.length - 1;
        while (lo < hi) {
            uint256 mid = (lo + hi + 1) / 2;
            if (obs[mid].timestamp <= target) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        Observation storage o = obs[lo];

        // The rate live after observation `lo` is the rate recorded at it.
        // We don't store it per-observation; reconstruct from the next
        // observation's cumulative delta, or use lastRate if `lo` is latest.
        uint256 liveRate;
        if (lo + 1 < obs.length) {
            Observation storage next = obs[lo + 1];
            liveRate = (uint256(next.cumulative) - o.cumulative) / (next.timestamp - o.timestamp);
        } else {
            liveRate = t.lastRate;
        }
        return uint256(o.cumulative) + liveRate * (target - o.timestamp);
    }
}
