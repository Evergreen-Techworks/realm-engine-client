#pragma once
// xorstr.h — MSVC C++17 compile-time XOR string encryption
//
// Usage:
//   const char*    s = xorstr("secret");
//   const wchar_t* w = xorstr_w(L"secret");

#include <cstddef>
#include <cstdint>
#include <utility>

namespace xor_detail {

// ── Compile-time seed from __TIME__ ─────────────────────────────────────────
// __TIME__ is always "HH:MM:SS" (8 chars). Manually unrolled so MSVC
// evaluates this as a constant expression without needing a loop.

constexpr uint32_t _fnv(uint32_t h, char c) noexcept {
    return (h ^ static_cast<uint32_t>(static_cast<unsigned char>(c))) * 0x01000193u;
}

constexpr uint32_t _seed() noexcept {
    constexpr char t[] = __TIME__; // "HH:MM:SS"
    uint32_t h = 0x811c9dc5u;
    h = _fnv(h, t[0]); h = _fnv(h, t[1]);
    h = _fnv(h, t[2]); h = _fnv(h, t[3]);
    h = _fnv(h, t[4]); h = _fnv(h, t[5]);
    h = _fnv(h, t[6]); h = _fnv(h, t[7]);
    return h;
}

constexpr uint8_t _key(size_t i) noexcept {
    uint32_t k = _seed() ^ static_cast<uint32_t>(i * 2654435761u);
    k = ((k >> 16) ^ k) * 0x45d9f3bu;
    k = ((k >> 16) ^ k) * 0x45d9f3bu;
    return static_cast<uint8_t>((k >> 16) ^ k);
}

// ── Encrypted storage (constexpr, lives in .rdata) ──────────────────────────

template<size_t N>
struct Enc {
    char buf[N];
    // Constructor is a member template so MSVC sees the pack correctly
    template<size_t... Is>
    constexpr Enc(const char(&s)[N], std::index_sequence<Is...>) noexcept
        : buf{ static_cast<char>(s[Is] ^ _key(Is))... } {}
};

template<size_t N>
struct EncW {
    wchar_t buf[N];
    template<size_t... Is>
    constexpr EncW(const wchar_t(&s)[N], std::index_sequence<Is...>) noexcept
        : buf{ static_cast<wchar_t>(s[Is] ^ static_cast<wchar_t>(_key(Is)))... } {}
};

// ── Runtime decryption ───────────────────────────────────────────────────────
// Uses plain `static` (not thread_local) so it works inside __try blocks.
// These strings are short-lived API arguments — not stored across threads.

template<size_t N>
__forceinline const char* _dec(const Enc<N>& e) noexcept {
    static char out[N];
    for (size_t i = 0; i < N; ++i)
        out[i] = e.buf[i] ^ static_cast<char>(_key(i));
    return out;
}

template<size_t N>
__forceinline const wchar_t* _decw(const EncW<N>& e) noexcept {
    static wchar_t out[N];
    for (size_t i = 0; i < N; ++i)
        out[i] = e.buf[i] ^ static_cast<wchar_t>(_key(i));
    return out;
}

} // namespace xor_detail

// ── Public macros ────────────────────────────────────────────────────────────

#define xorstr(s) ([]() noexcept -> const char* {                                   \
    constexpr static ::xor_detail::Enc<sizeof(s)> _e{                              \
        s, std::make_index_sequence<sizeof(s)>{}};                                  \
    return ::xor_detail::_dec(_e);                                                  \
}())

#define xorstr_w(s) ([]() noexcept -> const wchar_t* {                             \
    constexpr static ::xor_detail::EncW<sizeof(s)/sizeof(wchar_t)> _e{             \
        s, std::make_index_sequence<sizeof(s)/sizeof(wchar_t)>{}};                 \
    return ::xor_detail::_decw(_e);                                                 \
}())
