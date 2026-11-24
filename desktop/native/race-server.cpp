// Qonsole's socket adapter for the upstream portable room/sealer core.
#include "room.hpp"
#include "net/channel.hpp"
#include <map>
#include <memory>

using rr::net::Channel;
static std::unique_ptr<rr::netd::Server> server;
static std::map<int, std::unique_ptr<Channel>> clients;
static int next_id = 0;
static uint64_t now_ms = 0;

extern "C" {
void room_init(int seed) {
    rr::netd::ServerConfig config;
    config.seed = static_cast<uint32_t>(seed) | 1U;
    server = std::make_unique<rr::netd::Server>(config);
}
int room_open() {
    auto [client, host] = rr::net::loopback_pair({}, true, [] { return now_ms; });
    server->add_connection(std::move(host), now_ms);
    clients.emplace(++next_id, std::move(client));
    return next_id;
}
void room_close(int id) {
    auto client = clients.find(id);
    if (client != clients.end()) {
        client->second->close();
        clients.erase(client);
    }
}
void room_send(int id, const uint8_t* bytes, unsigned size) {
    auto client = clients.find(id);
    if (client != clients.end()) client->second->send({bytes, size});
}
int room_recv(int id, uint8_t* out, unsigned capacity) {
    auto client = clients.find(id);
    if (client == clients.end()) return -1;
    auto packet = client->second->poll();
    if (!packet) return client->second->status() == rr::net::ChannelStatus::closed ? -1 : 0;
    if (packet->size() > capacity) return -1;
    std::copy(packet->begin(), packet->end(), out);
    return static_cast<int>(packet->size());
}
void room_step(double time) {
    now_ms = static_cast<uint64_t>(time);
    server->step(now_ms);
}
}
