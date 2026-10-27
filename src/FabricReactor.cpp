#pragma once
#include <iostream>
#include <cstdint>
#include <vector>
#include "AINetInfraSim.hpp"

class FabricReactor {
public:
    void handle_signal(const Event& e, Registry& reg, EventDispatcher& dispatcher) {
        uint32_t link_id = e.entity_id;

        // 1. Physical Layer Check (Data-Oriented lookup)
        if (!reg.link_active[link_id]) {
            std::cout << "[T=" << e.timestamp << "] Signal DROPPED at Link " << link_id << "\n";
            return;
        }

        // 2. Topology Inter-relation (Port Map lookup)
        uint32_t next_link = reg.port_forwarding_table[link_id];

        if (next_link != 0) {
            // 3. Calculate future arrival time based on fiber length
            double arrival_time = e.timestamp + reg.link_latency[link_id];
            
            // 4. GENERATE THE NEXT ATOM
            dispatcher.schedule(arrival_time, EventType::SIGNAL_ARRIVAL, next_link);
            
            std::cout << "[T=" << e.timestamp << "] Signal moving " << link_id << " -> " << next_link << "\n";
        } else {
            std::cout << "[T=" << e.timestamp << "] SUCCESS: Signal reached Destination.\n";
        }
    }
};
