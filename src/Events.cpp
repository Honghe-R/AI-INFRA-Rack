#pragma once
#include <cstdint>
#include "AINetInfraSim.hpp"
enum class EventType { SIGNAL_ARRIVAL, LINK_FAILURE, COMPUTE_COMPLETE };

struct Event {
    double timestamp;      // The 'When'
    EventType type;        // The 'What'
    uint32_t entity_id;    // The 'Where' (Index into the Registry)

    // Overload for the Priority Queue (Smallest timestamp first)
    bool operator>(const Event& other) const {
        return timestamp > other.timestamp;
    }
};
