#include "../src/splash_logic.h"

#include <cstdio>
#include <cstdint>

static int g_checks = 0;
static int g_failures = 0;

#define CHECK(cond)                                                        \
    do {                                                                   \
        ++g_checks;                                                        \
        if (!(cond)) {                                                     \
            ++g_failures;                                                  \
            std::printf("  FAIL  %s:%d  %s\n", __FILE__, __LINE__, #cond); \
        }                                                                  \
    } while (0)

static void test_signature_matches_exact_three()
{
    const char* fields[] = { "timeForLogo", "logosToDisplay", "possibleSplashscreens" };
    CHECK(splash::MatchesSplashSignature(fields, 3) == true);
}

static void test_signature_matches_with_obfuscated_siblings()
{
    // Mirrors the real SplashScreenScript__Fields: markers readable, siblings mangled.
    const char* fields[] = {
        "background", "logo", "credits",
        "possibleSplashscreens", "logosToDisplay", "timeForLogo",
        "EFOMIEKLCDH", "HFCKLCHLCGF", "NBPKJFAAAHN",
    };
    CHECK(splash::MatchesSplashSignature(fields, 9) == true);
}

static void test_signature_rejects_partial_match()
{
    const char* fields[] = { "timeForLogo", "logosToDisplay" };
    CHECK(splash::MatchesSplashSignature(fields, 2) == false);
}

static void test_signature_rejects_empty_and_null()
{
    const char* fields[] = { "timeForLogo" };
    CHECK(splash::MatchesSplashSignature(fields, 0) == false);
    CHECK(splash::MatchesSplashSignature(nullptr, 3) == false);
    (void)fields;
}

static void test_signature_skips_null_entries()
{
    const char* fields[] = { nullptr, "timeForLogo", nullptr, "logosToDisplay",
                             "possibleSplashscreens", nullptr };
    CHECK(splash::MatchesSplashSignature(fields, 6) == true);
}

static void test_signature_is_case_sensitive()
{
    const char* fields[] = { "TimeForLogo", "logosToDisplay", "possibleSplashscreens" };
    CHECK(splash::MatchesSplashSignature(fields, 3) == false);
}

// Synthetic stand-ins for the verified IL2CPP layout:
//   List<float>: _items @ +0x10, _size @ +0x18   (il2cpp-types.h:47499)
//   float[]    : element data @ +0x20            (Il2CppResolver.h:7)
struct FakeArray {
    unsigned char header[0x20];
    float         data[8];
    std::uint32_t guard;
};

struct FakeList {
    unsigned char pad[0x10];
    void*         items;
    std::int32_t  size;
    std::int32_t  version;
};

static FakeArray MakeArray()
{
    FakeArray a{};
    for (int i = 0; i < 8; ++i) a.data[i] = 1.5f + static_cast<float>(i);
    a.guard = 0xDEADBEEFu;
    return a;
}

static void test_zero_clears_every_element()
{
    FakeArray arr = MakeArray();
    FakeList  lst{};
    lst.items = &arr;
    lst.size  = 3;

    const std::int32_t written = splash::ZeroFloatList(&lst, splash::kDefaultListFloatLayout);

    CHECK(written == 3);
    CHECK(arr.data[0] == 0.0f);
    CHECK(arr.data[1] == 0.0f);
    CHECK(arr.data[2] == 0.0f);
    CHECK(arr.data[3] == 4.5f);           // untouched beyond _size
    CHECK(arr.guard == 0xDEADBEEFu);      // no overrun
}

static void test_zero_is_noop_for_empty_list()
{
    FakeArray arr = MakeArray();
    FakeList  lst{};
    lst.items = &arr;
    lst.size  = 0;

    CHECK(splash::ZeroFloatList(&lst, splash::kDefaultListFloatLayout) == 0);
    CHECK(arr.data[0] == 1.5f);
}

static void test_zero_is_noop_for_negative_size()
{
    FakeArray arr = MakeArray();
    FakeList  lst{};
    lst.items = &arr;
    lst.size  = -1;

    CHECK(splash::ZeroFloatList(&lst, splash::kDefaultListFloatLayout) == 0);
    CHECK(arr.data[0] == 1.5f);
}

static void test_zero_rejects_implausible_size()
{
    // A garbage read must not turn into a wild write.
    FakeArray arr = MakeArray();
    FakeList  lst{};
    lst.items = &arr;
    lst.size  = splash::kMaxPlausibleLogoCount + 1;

    CHECK(splash::ZeroFloatList(&lst, splash::kDefaultListFloatLayout) == 0);
    CHECK(arr.data[0] == 1.5f);
    CHECK(arr.guard == 0xDEADBEEFu);
}

static void test_zero_is_noop_for_null_inputs()
{
    FakeList lst{};
    lst.items = nullptr;
    lst.size  = 3;

    CHECK(splash::ZeroFloatList(&lst, splash::kDefaultListFloatLayout) == 0);
    CHECK(splash::ZeroFloatList(nullptr, splash::kDefaultListFloatLayout) == 0);
}

int main()
{
    std::printf("splash_logic tests\n");
    test_signature_matches_exact_three();
    test_signature_matches_with_obfuscated_siblings();
    test_signature_rejects_partial_match();
    test_signature_rejects_empty_and_null();
    test_signature_skips_null_entries();
    test_signature_is_case_sensitive();
    test_zero_clears_every_element();
    test_zero_is_noop_for_empty_list();
    test_zero_is_noop_for_negative_size();
    test_zero_rejects_implausible_size();
    test_zero_is_noop_for_null_inputs();

    std::printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
