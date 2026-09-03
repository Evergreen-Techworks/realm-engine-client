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

int main()
{
    std::printf("splash_logic tests\n");
    test_signature_matches_exact_three();
    test_signature_matches_with_obfuscated_siblings();
    test_signature_rejects_partial_match();
    test_signature_rejects_empty_and_null();
    test_signature_skips_null_entries();
    test_signature_is_case_sensitive();

    std::printf("%d checks, %d failures\n", g_checks, g_failures);
    return g_failures == 0 ? 0 : 1;
}
