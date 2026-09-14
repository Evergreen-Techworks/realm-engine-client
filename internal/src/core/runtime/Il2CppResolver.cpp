#include "pch-il2cpp.h"
#include "BuildBindings.h"
#include <shellapi.h>
#include <cstdio>
#include <cstring>

#include "Il2CppResolver.h"
#include "helpers.h"

namespace {

std::string TypeNameAlloc(const Il2CppType* t)
{
	if (!t) return "?";
	char* name = il2cpp_type_get_name(t);
	std::string s = name ? name : "?";
	if (name) il2cpp_free(name);
	return s;
}

std::string FormatReferenceReturn(const Il2CppType* t, Il2CppObject* obj)
{
	std::string prefix = TypeNameAlloc(t);
	char addr[48];
	sprintf_s(addr, " @ 0x%p", (void*)obj);
	return prefix + addr;
}

// obj non-null; t not void
std::string FormatBoxedIl2CppObject(const Il2CppType* t, Il2CppObject* obj)
{
	const int type = il2cpp_type_get_type(t);

	switch (type) {
	case IL2CPP_TYPE_BOOLEAN: {
		bool v = *(bool*)il2cpp_object_unbox(obj);
		return v ? "true" : "false";
	}
	case IL2CPP_TYPE_I1:
		return std::to_string(*(int8_t*)il2cpp_object_unbox(obj));
	case IL2CPP_TYPE_U1:
		return std::to_string(*(uint8_t*)il2cpp_object_unbox(obj));
	case IL2CPP_TYPE_I2:
		return std::to_string(*(int16_t*)il2cpp_object_unbox(obj));
	case IL2CPP_TYPE_U2:
		return std::to_string(*(uint16_t*)il2cpp_object_unbox(obj));
	case IL2CPP_TYPE_CHAR: {
		uint16_t c = *(uint16_t*)il2cpp_object_unbox(obj);
		char buf[32];
		sprintf_s(buf, "U+%04X", (unsigned)c);
		return buf;
	}
	case IL2CPP_TYPE_I4:
	case IL2CPP_TYPE_ENUM:
		return std::to_string(*(int32_t*)il2cpp_object_unbox(obj));
	case IL2CPP_TYPE_U4:
		return std::to_string(*(uint32_t*)il2cpp_object_unbox(obj));
	case IL2CPP_TYPE_I8:
		return std::to_string(*(int64_t*)il2cpp_object_unbox(obj));
	case IL2CPP_TYPE_U8:
		return std::to_string(*(uint64_t*)il2cpp_object_unbox(obj));
	case IL2CPP_TYPE_I:
		return std::to_string(*(intptr_t*)il2cpp_object_unbox(obj));
	case IL2CPP_TYPE_U:
		return std::to_string(*(uintptr_t*)il2cpp_object_unbox(obj));
	case IL2CPP_TYPE_R4: {
		char buf[64];
		sprintf_s(buf, "%.9g", (double)*(float*)il2cpp_object_unbox(obj));
		return buf;
	}
	case IL2CPP_TYPE_R8: {
		char buf[64];
		sprintf_s(buf, "%.17g", *(double*)il2cpp_object_unbox(obj));
		return buf;
	}
	case IL2CPP_TYPE_STRING:
		return il2cppi_to_string((Il2CppString*)obj);
	case IL2CPP_TYPE_VALUETYPE: {
		Il2CppClass* k = il2cpp_class_from_type(t);
		if (!k) return "{valuetype?}";
		const char* cn = il2cpp_class_get_name(k);
		void* ub = il2cpp_object_unbox(obj);
		if (cn && std::strcmp(cn, "Vector3") == 0) {
			const app::Vector3* v = static_cast<const app::Vector3*>(ub);
			char buf[128];
			sprintf_s(buf, "Vector3(%.9g,%.9g,%.9g)", (double)v->x, (double)v->y, (double)v->z);
			return buf;
		}
		return std::string("{") + (cn ? cn : "?") + "}";
	}
	case IL2CPP_TYPE_CLASS:
	case IL2CPP_TYPE_OBJECT:
	case IL2CPP_TYPE_SZARRAY:
	case IL2CPP_TYPE_ARRAY:
	case IL2CPP_TYPE_GENERICINST:
		if (!Resolver::Protection::IsValidIl2CppObject(obj))
			return "null";
		return FormatReferenceReturn(t, obj);
	default:
		return TypeNameAlloc(t) + "?";
	}
}

std::string FormatUnboxedPrimitive(const Il2CppType* t, void* data)
{
	if (!data) return "null";
	const int type = il2cpp_type_get_type(t);
	switch (type) {
	case IL2CPP_TYPE_BOOLEAN:
		return *(bool*)data ? "true" : "false";
	case IL2CPP_TYPE_I1:
		return std::to_string(*(int8_t*)data);
	case IL2CPP_TYPE_U1:
		return std::to_string(*(uint8_t*)data);
	case IL2CPP_TYPE_I2:
		return std::to_string(*(int16_t*)data);
	case IL2CPP_TYPE_U2:
		return std::to_string(*(uint16_t*)data);
	case IL2CPP_TYPE_CHAR: {
		char buf[32];
		sprintf_s(buf, "U+%04X", (unsigned)*(uint16_t*)data);
		return buf;
	}
	case IL2CPP_TYPE_I4:
	case IL2CPP_TYPE_ENUM:
		return std::to_string(*(int32_t*)data);
	case IL2CPP_TYPE_U4:
		return std::to_string(*(uint32_t*)data);
	case IL2CPP_TYPE_I8:
		return std::to_string(*(int64_t*)data);
	case IL2CPP_TYPE_U8:
		return std::to_string(*(uint64_t*)data);
	case IL2CPP_TYPE_I:
		return std::to_string(*(intptr_t*)data);
	case IL2CPP_TYPE_U:
		return std::to_string(*(uintptr_t*)data);
	case IL2CPP_TYPE_R4: {
		char buf[64];
		sprintf_s(buf, "%.9g", (double)*(float*)data);
		return buf;
	}
	case IL2CPP_TYPE_R8: {
		char buf[64];
		sprintf_s(buf, "%.17g", *(double*)data);
		return buf;
	}
	default:
		return "?";
	}
}

std::string FormatFieldValueInner(Il2CppObject* obj, FieldInfo* field)
{
	if (!field || !field->type) return "?";
	const bool isStatic = (field->type->attrs & 0x0010) != 0;
	if (!isStatic && !obj) return "null (instance only)";

	if (il2cpp_field_is_literal(field))
		return "<literal>";

	const Il2CppType* type = il2cpp_field_get_type(field);
	if (!type) return "?";
	const int typeEnum = il2cpp_type_get_type(type);

	switch (typeEnum) {
	case IL2CPP_TYPE_BOOLEAN: {
		bool v = false;
		Resolver::GetFieldValue(obj, field, &v);
		return v ? "true" : "false";
	}
	case IL2CPP_TYPE_I1: {
		int8_t v = 0;
		Resolver::GetFieldValue(obj, field, &v);
		return std::to_string(v);
	}
	case IL2CPP_TYPE_U1: {
		uint8_t v = 0;
		Resolver::GetFieldValue(obj, field, &v);
		return std::to_string(v);
	}
	case IL2CPP_TYPE_I2: {
		int16_t v = 0;
		Resolver::GetFieldValue(obj, field, &v);
		return std::to_string(v);
	}
	case IL2CPP_TYPE_U2: {
		uint16_t v = 0;
		Resolver::GetFieldValue(obj, field, &v);
		return std::to_string(v);
	}
	case IL2CPP_TYPE_CHAR: {
		uint16_t v = 0;
		Resolver::GetFieldValue(obj, field, &v);
		char buf[32];
		sprintf_s(buf, "U+%04X", (unsigned)v);
		return buf;
	}
	case IL2CPP_TYPE_I4:
	case IL2CPP_TYPE_ENUM: {
		int32_t v = 0;
		Resolver::GetFieldValue(obj, field, &v);
		return std::to_string(v);
	}
	case IL2CPP_TYPE_U4: {
		uint32_t v = 0;
		Resolver::GetFieldValue(obj, field, &v);
		return std::to_string(v);
	}
	case IL2CPP_TYPE_I8: {
		int64_t v = 0;
		Resolver::GetFieldValue(obj, field, &v);
		return std::to_string(v);
	}
	case IL2CPP_TYPE_U8: {
		uint64_t v = 0;
		Resolver::GetFieldValue(obj, field, &v);
		return std::to_string(v);
	}
	case IL2CPP_TYPE_I: {
		intptr_t v = 0;
		Resolver::GetFieldValue(obj, field, &v);
		return std::to_string(v);
	}
	case IL2CPP_TYPE_U: {
		uintptr_t v = 0;
		Resolver::GetFieldValue(obj, field, &v);
		return std::to_string(v);
	}
	case IL2CPP_TYPE_R4: {
		float v = 0.f;
		Resolver::GetFieldValue(obj, field, &v);
		char buf[64];
		sprintf_s(buf, "%.9g", (double)v);
		return buf;
	}
	case IL2CPP_TYPE_R8: {
		double v = 0.;
		Resolver::GetFieldValue(obj, field, &v);
		char buf[64];
		sprintf_s(buf, "%.17g", v);
		return buf;
	}
	case IL2CPP_TYPE_STRING: {
		Il2CppString* s = nullptr;
		Resolver::GetFieldValue(obj, field, &s);
		if (!s) return "null";
		return il2cppi_to_string(s);
	}
	case IL2CPP_TYPE_VALUETYPE: {
		Il2CppClass* sk = il2cpp_class_from_type(type);
		if (!sk) return "{valuetype?}";
		const char* cn = il2cpp_class_get_name(sk);
		if (cn && std::strcmp(cn, "Vector3") == 0) {
			app::Vector3 v{};
			Resolver::GetFieldValue(obj, field, &v);
			char buf[128];
			sprintf_s(buf, "Vector3(%.9g,%.9g,%.9g)", (double)v.x, (double)v.y, (double)v.z);
			return buf;
		}
		if (cn && std::strcmp(cn, "Color") == 0) {
			float c[4] = {};
			Resolver::GetFieldValue(obj, field, c);
			char buf[128];
			sprintf_s(buf, "Color(%.4g,%.4g,%.4g,%.4g)", (double)c[0], (double)c[1], (double)c[2], (double)c[3]);
			return buf;
		}
		if (cn && std::strcmp(cn, "Color32") == 0) {
			uint8_t c[4] = {};
			Resolver::GetFieldValue(obj, field, c);
			char buf[64];
			sprintf_s(buf, "Color32(%u,%u,%u,%u)", (unsigned)c[0], (unsigned)c[1], (unsigned)c[2], (unsigned)c[3]);
			return buf;
		}
		return std::string("{") + (cn ? cn : "?") + "}";
	}
	case IL2CPP_TYPE_CLASS:
	case IL2CPP_TYPE_OBJECT:
	case IL2CPP_TYPE_SZARRAY:
	case IL2CPP_TYPE_ARRAY:
	case IL2CPP_TYPE_GENERICINST: {
		Il2CppObject* val = nullptr;
		Resolver::GetFieldValue(obj, field, &val);
		if (!val) return "null";
		if (!Resolver::Protection::IsValidIl2CppObject(val)) return "<invalid ptr>";
		char addr[48];
		sprintf_s(addr, "0x%p", (void*)val);
		return TypeNameAlloc(type) + " @ " + addr;
	}
	default:
		return TypeNameAlloc(type) + "?";
	}
}

} // namespace

namespace Resolver::Protection {
	Il2CppObject* SafeRuntimeInvoke(const MethodInfo* method, Il2CppObject* obj, void** params)
	{
		if (!method || (!obj && !(method->flags & 0x0010))) return nullptr;
		Il2CppObject* result = nullptr;
		Il2CppException* exc = nullptr;
		bool success = Protection::safe_call([&]() {
			result = il2cpp_runtime_invoke(method, obj, params, &exc);
			});
		return (success && !exc) ? result : nullptr;
	}

	bool IsAlive(Il2CppObject* obj)
	{
		if (!IsValidIl2CppObject(obj)) return false;
		static Il2CppClass* objectClass = Resolver::FindClass("UnityEngine", "Object");
		static const MethodInfo* op_Implicit = il2cpp_class_get_method_from_name(objectClass, "op_Implicit", 1);
		void* params[] = { obj };
		Il2CppObject* result = SafeRuntimeInvoke(op_Implicit, obj, params);
		return result && *(bool*)il2cpp_object_unbox(result);
	}
}

namespace Resolver {
	// il2cpp_domain_get_assemblies is not exported by this build.
	// Use il2cpp_class_for_each to scan all loaded classes instead.
	Il2CppClass* GetClass(const char* namespaze, const char* name)
	{
		struct Ctx { const char* ns; const char* name; Il2CppClass* result; };
		Ctx ctx{ namespaze, BuildBindings::ClassName(name), nullptr };
		il2cpp_class_for_each([](Il2CppClass* klass, void* ud) {
			auto* c = static_cast<Ctx*>(ud);
			if (c->result) return;
			if (strcmp(il2cpp_class_get_namespace(klass), c->ns) == 0 &&
				strcmp(il2cpp_class_get_name(klass), c->name) == 0)
				c->result = klass;
		}, &ctx);
		return ctx.result;
	}

	Il2CppClass* FindClass(const char* namespaze, const char* name)
	{
		return GetClass(namespaze, name);
	}

	Il2CppClass* FindClassLoose(const char* className)
	{
		if (!className || !className[0]) return nullptr;
		struct Ctx { const char* name; Il2CppClass* result; };
		Ctx ctx{ BuildBindings::ClassName(className), nullptr };
		il2cpp_class_for_each([](Il2CppClass* klass, void* ud) {
			auto* c = static_cast<Ctx*>(ud);
			if (c->result) return;
			if (strcmp(il2cpp_class_get_name(klass), c->name) == 0)
				c->result = klass;
		}, &ctx);
		return ctx.result;
	}

	std::vector<Il2CppObject*> FindObjectsByType(Il2CppClass* targetClass)
	{
		std::vector<Il2CppObject*> foundObjects;
		if (!targetClass) return foundObjects;

		static Il2CppClass* unityObjectClass = Resolver::FindClass("UnityEngine", "Object");
		static const MethodInfo* findMethod = il2cpp_class_get_method_from_name(unityObjectClass, "FindObjectsOfType", 1);

		if (!findMethod) return foundObjects;

		const Il2CppType* type = il2cpp_class_get_type(targetClass);
		Il2CppReflectionType* reflectionType = (Il2CppReflectionType*)il2cpp_type_get_object(type);

		void* params[] = { reflectionType };
		Il2CppArray* results = (Il2CppArray*)Resolver::Protection::SafeRuntimeInvoke(findMethod, nullptr, params);

		if (results) {
			uint32_t count = il2cpp_array_length(results);
			for (uint32_t i = 0; i < count; i++) {
				Il2CppObject* obj = GET_ARRAY_ELEMENT(results, i);
				if (Resolver::Protection::IsAlive(obj)) {
					foundObjects.push_back(obj);
				}
			}
		}
		return foundObjects;
	}

	void GetFieldValue(Il2CppObject* obj, FieldInfo* field, void* outValue)
	{
		if (field->type->attrs & 0x0010) {
			il2cpp_field_static_get_value(field, outValue);
		}
		else if (obj) {
			il2cpp_field_get_value(obj, field, outValue);
		}
	}

	std::string FormatIl2CppReturn(const MethodInfo* method, Il2CppObject* boxedOrNull)
	{
		if (!method) return "?";
		const Il2CppType* rt = il2cpp_method_get_return_type(method);
		if (!rt) return "?";
		const int kind = il2cpp_type_get_type(rt);
		if (kind == IL2CPP_TYPE_VOID)
			return "void";
		if (!boxedOrNull)
			return "null";
		std::string out;
		const bool ok = Protection::safe_call([&]() {
			out = FormatBoxedIl2CppObject(rt, boxedOrNull);
		});
		return ok ? out : "<error>";
	}

	std::string FormatByType(const Il2CppType* type, void* data, bool isBoxed)
	{
		if (!type) return "?";
		const int kind = il2cpp_type_get_type(type);
		if (kind == IL2CPP_TYPE_VOID)
			return "void";
		if (isBoxed) {
			auto* obj = static_cast<Il2CppObject*>(data);
			if (!obj)
				return "null";
			std::string out;
			const bool ok = Protection::safe_call([&]() {
				out = FormatBoxedIl2CppObject(type, obj);
			});
			return ok ? out : "<error>";
		}
		return FormatUnboxedPrimitive(type, data);
	}

	std::string FormatFieldValueAsText(Il2CppObject* obj, FieldInfo* field)
	{
		if (!field) return "?";
		std::string out;
		const bool ok = Protection::safe_call([&]() {
			out = FormatFieldValueInner(obj, field);
		});
		return ok ? out : "<error>";
	}
}


namespace Resolver::Helpers{
	void OpenURL(const char* url) {
		ShellExecuteA(NULL, "open", url, NULL, NULL, SW_SHOWNORMAL);
	}

	std::string GetSceneName(Il2CppObject* gameObject) {
		if (!Resolver::Protection::IsAlive(gameObject)) return "Unknown";

		std::string resultName = "Unknown Scene";

		Resolver::Protection::safe_call([&]() {

			static Il2CppClass* goClass = Resolver::FindClass("UnityEngine", "GameObject");
			static const MethodInfo* getScene = goClass ? il2cpp_class_get_method_from_name(goClass, "get_scene", 0) : nullptr;

			if (!getScene) return;

			Il2CppObject* sceneBoxed = Resolver::Protection::SafeRuntimeInvoke(getScene, gameObject, nullptr);

			if (!sceneBoxed) {
				resultName = "DontDestroyOnLoad";
				return;
			}

			Il2CppClass* sceneClass = il2cpp_object_get_class(sceneBoxed);
			static const MethodInfo* getSceneName = sceneClass ? il2cpp_class_get_method_from_name(sceneClass, "get_name", 0) : nullptr;

			if (getSceneName) {
				Il2CppString* sName = (Il2CppString*)Resolver::Protection::SafeRuntimeInvoke(getSceneName, sceneBoxed, nullptr);
				if (sName) {
					resultName = il2cppi_to_string(sName);
				}
			}
			});

		return resultName;
	}

	void Helpers::CopyToClipboard(const char* text)
	{
		if (OpenClipboard(NULL)) {
			EmptyClipboard();
			HGLOBAL hg = GlobalAlloc(GMEM_MOVEABLE, strlen(text) + 1);
			if (hg) {
				memcpy(GlobalLock(hg), text, strlen(text) + 1);
				GlobalUnlock(hg);
				SetClipboardData(CF_TEXT, hg);
			}
			CloseClipboard();
		}
	}
}

