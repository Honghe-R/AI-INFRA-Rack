#pragma once
#include <vector>
#include <list>
#include <limits>
#include "Events.cpp"
#include <cstdint>

// A simple LadderQueue for event scheduling
class LadderQueue {
public:
    LadderQueue(double bucketWidth = 1.0, size_t numBuckets = 128)
        : bucketWidth(bucketWidth), numBuckets(numBuckets), buckets(numBuckets), current_time(0.0), current_bucket(0), size_(0) {}

    void push(const Event& e) {
        size_++;
        size_t idx = bucketIndex(e.timestamp);
        buckets[idx].push_back(e);
    }

    bool empty() const { return size_ == 0; }

    Event pop() {
        // Try to pop from the current bucket
        promote_if_needed();
        if (!buckets[current_bucket].empty()) {
            // Find the event with the smallest timestamp in this bucket
            auto minIt = buckets[current_bucket].begin();
            for (auto it = buckets[current_bucket].begin(); it != buckets[current_bucket].end(); ++it) {
                if (it->timestamp < minIt->timestamp) minIt = it;
            }
            Event e = *minIt;
            buckets[current_bucket].erase(minIt);
            size_--;
            current_time = e.timestamp;
            return e;
        }
        throw std::runtime_error("LadderQueue is empty after promotion");
    }

    double get_current_time() const { return current_time; }

private:
    double bucketWidth;
    size_t numBuckets;
    std::vector<std::list<Event>> buckets;
    double current_time;
    size_t current_bucket;
    size_t size_;

    size_t bucketIndex(double timestamp) const {
        return static_cast<size_t>(timestamp / bucketWidth) % numBuckets;
    }

    // Promote events from the next non-empty bucket to the current bucket if needed
    void promote_if_needed() {
        // If current bucket is empty, find the next non-empty bucket
        while (buckets[current_bucket].empty() && size_ > 0) {
            size_t next_bucket = (current_bucket + 1) % numBuckets;
            if (!buckets[next_bucket].empty()) {
                // Move all events from next_bucket to current_bucket
                buckets[current_bucket].splice(buckets[current_bucket].end(), buckets[next_bucket]);
                // Advance current_time to the earliest event in the new current_bucket
                if (!buckets[current_bucket].empty()) {
                    current_time = buckets[current_bucket].front().timestamp;
                }
            }
            current_bucket = next_bucket;
        }
    }
};
