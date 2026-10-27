#pragma once
#include "LadderQueue.hpp"
#include "AINetInfraSim.hpp"

class FabricReactor; // Forward declaration

class EventDispatcher {
public:
    // The Global Ladder Queue (The 'Glue')
    LadderQueue queue;
    double current_time = 0.0;

    void schedule(double time, EventType type, uint32_t id) {
        queue.push({time, type, id});
    }

    // Deferred implementation to resolve circular dependency
    void run(Registry& reg, FabricReactor& reactor);
};
