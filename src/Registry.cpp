#pragma once
#include <vector>
#include "AINetInfraSim.hpp"

struct Registry {
    // Physical Layer
    std::vector<bool>  link_active;    // [LinkID] -> Active Status
    std::vector<float> link_latency;   // [LinkID] -> Nanoseconds
    
    // Topology Layer (The "Inter-relation" Glue)
    // For this demo: PortMap[CurrentLink] = NextLink
    std::vector<EntityID> port_forwarding_table; 
};