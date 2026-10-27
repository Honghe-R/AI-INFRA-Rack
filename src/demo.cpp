#include <vector>
#include <iostream>
#include <cstdint>
#include <queue>
#include "AINetInfraSim.hpp"

// --- Include Components ---
#include "Events.cpp"
#include "Registry.cpp"
// Order matters: EventDispatcher forward declares FabricReactor
#include "EventDispatcher.cpp" 
// FabricReactor uses EventDispatcher definition
#include "FabricReactor.cpp"

// --- Implement EventDispatcher::run ---
// Now that FabricReactor is fully defined
void EventDispatcher::run(Registry& reg, FabricReactor& reactor) {
    while (!queue.empty()) {
        Event e = queue.top();
        queue.pop();

        // Advance the Global Clock
        current_time = e.timestamp;

        // Route to the appropriate Reaction Processor
        if (e.type == EventType::SIGNAL_ARRIVAL) {
            // The Reactor might schedule NEW events back into the queue
            reactor.handle_signal(e, reg, *this);
        } 
        else if (e.type == EventType::LINK_FAILURE) {
            reg.link_active[e.entity_id] = false;
            std::cout << "[T=" << current_time << "] !!! HARDWARE FAILURE on Link " << e.entity_id << "\n";
        }
    }
}

int main() {
    Registry world; // (Same as previous: 101 -> 102 -> 103 -> 104)
    world.link_active = {true, true, true, true, true, true, true, true, true, true}; 
    world.link_active.resize(200, true);
    world.link_latency.resize(200, 10.5f);
    world.port_forwarding_table.resize(200, 0);

    world.port_forwarding_table[101] = 102; // Link 101 flows into 102
    world.port_forwarding_table[102] = 0;   // Link 102 is the end

    EventDispatcher engine;
    FabricReactor reactor;

    // Start a signal at T=0
    engine.schedule(0.0, EventType::SIGNAL_ARRIVAL, 101);

    // Schedule a sabotage! Link 103 will fail at T=15.0
    engine.schedule(15.0, EventType::LINK_FAILURE, 103);

    std::cout << "--- Starting Simulation ---\n";
    engine.run(world, reactor);

    return 0;
}
