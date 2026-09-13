
      // IL2CPP application initializer — update-proof via GetProcAddress

      #include "pch-il2cpp.h"

      #include "il2cpp-appdata.h"
      #include "il2cpp-init.h"
      #include "helpers.h"
      #include "xorstr.h"
      #include "DbgFileLog.h"
      #include "../runtime/BuildBindings.h"

      // IL2CPP API function pointer definitions (storage)
      #define DO_API(r, n, p) r (*n) p
      #include "il2cpp-api-functions.h"
      #undef DO_API

      // Application-specific function pointer storage (kept for link compatibility)
      #define DO_APP_FUNC(a, r, n, p) r (*n) p
      #define DO_APP_FUNC_METHODINFO(a, n) struct MethodInfo ** n
      namespace app {
      #include "il2cpp-functions.h"
      }
      #undef DO_APP_FUNC
      #undef DO_APP_FUNC_METHODINFO

      // TypeInfo pointer storage (kept for link compatibility)
      #define DO_TYPEDEF(a, n) n ## __Class** n ## __TypeInfo
      namespace app {
      #include "il2cpp-types-ptr.h"
      }
      #undef DO_TYPEDEF

      // Route the three IL2CPP lookup entry points through the generated bindings so
      // every caller -- the offset table, Il2CppHook::ResolveMethod(Cached), feature
      // code -- sees this build's names. With no generated header each is a pass-through.
      static decltype(il2cpp_class_get_method_from_name) originalMethodFromName = nullptr;
      static decltype(il2cpp_class_from_name) originalClassFromName = nullptr;
      static decltype(il2cpp_class_get_field_from_name) originalFieldFromName = nullptr;
      static Il2CppClass* BoundClassFromName(const Il2CppImage* image, const char* ns, const char* name) {
          return originalClassFromName(image, ns, BuildBindings::ClassName(name));
      }
      static FieldInfo* BoundFieldFromName(Il2CppClass* klass, const char* name) {
          if (!klass || !name) return nullptr;
          return originalFieldFromName(klass, BuildBindings::FieldName(il2cpp_class_get_name(klass), name));
      }
      // A bound method is authenticated by its compiled address: the lookup succeeds only
      // for the declared method whose pointer is this build's RVA. Unbound lookups keep
      // IL2CPP's own by-name behaviour.
      static const MethodInfo* BoundMethodFromName(Il2CppClass* klass, const char* name, int args) {
          if (!klass || !name) return nullptr;
          const auto* row = BuildBindings::Method(il2cpp_class_get_name(klass), name, args);
          if (!row) return originalMethodFromName(klass, name, args);
          const uintptr_t expected = reinterpret_cast<uintptr_t>(GetModuleHandleW(L"GameAssembly.dll")) + row->rva;
          void* iter = nullptr;
          while (const MethodInfo* method = il2cpp_class_get_methods(klass, &iter)) {
              if (reinterpret_cast<uintptr_t>(method->methodPointer) == expected &&
                  strcmp(il2cpp_method_get_name(method), row->target) == 0 &&
                  static_cast<int>(il2cpp_method_get_param_count(method)) == args) return method;
          }
          return nullptr;
      }

      void init_il2cpp(HMODULE hGameAssembly)
      {
      DBG_FILE_LOG("[init_il2cpp] entered (pre-resolved handle=" << (void*)hGameAssembly << ")");
      HMODULE hMod = hGameAssembly;
      if (!hMod) {
      hMod = GetModuleHandleW(L"GameAssembly.dll");
      DBG_FILE_LOG("[init_il2cpp] Fallback GetModuleHandleW -> " << (void*)hMod);
      }
      if (!hMod) {
      DBG_FILE_LOG("[init_il2cpp] GameAssembly.dll NOT LOADED — aborting.");
      return;
      }

      DBG_FILE_LOG("[init_il2cpp] Resolving IL2CPP API via GetProcAddress...");
      #define DO_API(r, n, p) n = reinterpret_cast<r(*) p>(GetProcAddress(hMod, #n))
      #include "il2cpp-api-functions.h"
      #undef DO_API
      originalMethodFromName = il2cpp_class_get_method_from_name;
      if (originalMethodFromName && il2cpp_class_get_name && il2cpp_class_get_methods && il2cpp_method_get_name && il2cpp_method_get_param_count) il2cpp_class_get_method_from_name = BoundMethodFromName;
      originalClassFromName = il2cpp_class_from_name;
      originalFieldFromName = il2cpp_class_get_field_from_name;
      if (originalClassFromName) il2cpp_class_from_name = BoundClassFromName;
      if (originalFieldFromName && il2cpp_class_get_name) il2cpp_class_get_field_from_name = BoundFieldFromName;
      DBG_FILE_LOG("[init_il2cpp] API pointers and build bindings installed.");
      }
