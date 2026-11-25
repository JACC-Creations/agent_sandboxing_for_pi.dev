#include <Windows.h>

#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <iostream>
#include <memory>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <utility>

namespace
{
	constexpr DWORD ChangeFilter = FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME
		| FILE_NOTIFY_CHANGE_ATTRIBUTES | FILE_NOTIFY_CHANGE_SIZE | FILE_NOTIFY_CHANGE_LAST_WRITE
		| FILE_NOTIFY_CHANGE_CREATION | FILE_NOTIFY_CHANGE_SECURITY;
	constexpr std::size_t BufferSize = 64U * 1024U;

	struct FOptions
	{
		std::filesystem::path Lower;
		std::filesystem::path State;
		std::filesystem::path Quarantine;
		std::wstring BrokerUuid;
		std::wstring TestFailure;
		bool bTestMode = false;
	};

	struct FRootIdentity
	{
		DWORD VolumeSerial = 0;
		std::uint64_t FileIndex = 0;
		std::wstring FinalPath;
	};

	struct FHandleCloser
	{
		void operator()(void* Handle) const
		{
			if (Handle != nullptr && Handle != INVALID_HANDLE_VALUE)
			{
				CloseHandle(Handle);
			}
		}
	};
	using FUniqueHandle = std::unique_ptr<void, FHandleCloser>;

	class FDirectoryChangeRead
	{
	public:
		FDirectoryChangeRead(HANDLE InDirectory, HANDLE InEvent)
			: Directory(InDirectory), Event(InEvent)
		{
		}

		~FDirectoryChangeRead()
		{
			Settle();
		}

		bool Arm(void* Buffer, const DWORD BufferByteCount)
		{
			if (bPending || ResetEvent(Event) == FALSE)
			{
				return false;
			}
			Overlapped = {};
			Overlapped.hEvent = Event;
			if (ReadDirectoryChangesW(Directory, Buffer, BufferByteCount, TRUE,
				ChangeFilter, nullptr, &Overlapped, nullptr) == FALSE)
			{
				return false;
			}
			bPending = true;
			return true;
		}

		bool Complete(DWORD& Bytes)
		{
			if (!bPending)
			{
				return false;
			}
			const bool bCompleted = GetOverlappedResult(Directory, &Overlapped, &Bytes, FALSE) != FALSE;
			bPending = false;
			return bCompleted;
		}

	private:
		void Settle()
		{
			if (!bPending)
			{
				return;
			}
			CancelIoEx(Directory, &Overlapped);
			DWORD Bytes = 0;
			GetOverlappedResult(Directory, &Overlapped, &Bytes, TRUE);
			bPending = false;
		}

		HANDLE Directory = INVALID_HANDLE_VALUE;
		HANDLE Event = nullptr;
		OVERLAPPED Overlapped{};
		bool bPending = false;
	};

	std::string Utf8(const std::wstring& Value)
	{
		if (Value.empty())
		{
			return {};
		}
		const int Required = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, Value.data(),
			static_cast<int>(Value.size()), nullptr, 0, nullptr, nullptr);
		if (Required <= 0)
		{
			return {};
		}
		std::string Result(static_cast<std::size_t>(Required), '\0');
		if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, Value.data(), static_cast<int>(Value.size()),
			Result.data(), Required, nullptr, nullptr) != Required)
		{
			return {};
		}
		return Result;
	}

	std::string JsonEscape(const std::wstring& Value)
	{
		std::string Result;
		for (const unsigned char Character : Utf8(Value))
		{
			switch (Character)
			{
			case '\\': Result += "\\\\"; break;
			case '"': Result += "\\\""; break;
			case '\r': Result += "\\r"; break;
			case '\n': Result += "\\n"; break;
			case '\t': Result += "\\t"; break;
			default:
				if (Character < 0x20)
				{
					char Buffer[7]{};
					sprintf_s(Buffer, "\\u%04x", Character);
					Result += Buffer;
				}
				else
				{
					Result.push_back(static_cast<char>(Character));
				}
			}
		}
		return Result;
	}

	std::string IsoTimestamp()
	{
		SYSTEMTIME Time{};
		GetSystemTime(&Time);
		char Buffer[32]{};
		sprintf_s(Buffer, "%04u-%02u-%02uT%02u:%02u:%02u.%03uZ", Time.wYear, Time.wMonth, Time.wDay,
			Time.wHour, Time.wMinute, Time.wSecond, Time.wMilliseconds);
		return Buffer;
	}

	bool AtomicWrite(const std::filesystem::path& Destination, const std::string& Contents)
	{
		std::error_code Error;
		std::filesystem::create_directories(Destination.parent_path(), Error);
		if (Error)
		{
			return false;
		}
		const std::filesystem::path Temporary = Destination.wstring() + L".tmp." + std::to_wstring(GetCurrentProcessId());
		for (int Attempt = 0; Attempt < 20; ++Attempt)
		{
			FUniqueHandle File(CreateFileW(Temporary.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
				FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH, nullptr));
			if (File.get() != INVALID_HANDLE_VALUE)
			{
				DWORD Written = 0;
				const bool bWritten = Contents.size() <= MAXDWORD
					&& WriteFile(File.get(), Contents.data(), static_cast<DWORD>(Contents.size()), &Written, nullptr) != FALSE
					&& Written == Contents.size() && FlushFileBuffers(File.get()) != FALSE;
				File.reset();
				if (bWritten && MoveFileExW(Temporary.c_str(), Destination.c_str(),
					MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != FALSE)
				{
					return true;
				}
			}
			DeleteFileW(Temporary.c_str());
			if (Attempt + 1 < 20)
			{
				Sleep(25);
			}
		}
		return false;
	}

	std::optional<std::wstring> GetFinalPath(HANDLE Directory)
	{
		const DWORD Required = GetFinalPathNameByHandleW(Directory, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
		if (Required == 0)
		{
			return std::nullopt;
		}
		std::wstring Result(Required, L'\0');
		const DWORD Length = GetFinalPathNameByHandleW(Directory, Result.data(), Required,
			FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
		if (Length == 0 || Length >= Required)
		{
			return std::nullopt;
		}
		Result.resize(Length);
		return Result;
	}

	std::optional<FRootIdentity> GetRootIdentity(HANDLE Directory)
	{
		BY_HANDLE_FILE_INFORMATION Information{};
		const std::optional<std::wstring> FinalPath = GetFinalPath(Directory);
		if (!FinalPath || GetFileInformationByHandle(Directory, &Information) == FALSE)
		{
			return std::nullopt;
		}
		return FRootIdentity{Information.dwVolumeSerialNumber,
			(static_cast<std::uint64_t>(Information.nFileIndexHigh) << 32U) | Information.nFileIndexLow,
			*FinalPath};
	}

	bool IdentityMatches(HANDLE Directory, const FRootIdentity& Expected)
	{
		const std::optional<FRootIdentity> Current = GetRootIdentity(Directory);
		return Current && Current->VolumeSerial == Expected.VolumeSerial
			&& Current->FileIndex == Expected.FileIndex && _wcsicmp(Current->FinalPath.c_str(), Expected.FinalPath.c_str()) == 0;
	}

	std::string StateJson(const FOptions& Options, const FRootIdentity& Identity, const char* Phase,
		const std::string& Reason = {})
	{
		return "{\n  \"version\":2,\n  \"brokerUuid\":\"" + JsonEscape(Options.BrokerUuid)
			+ "\",\n  \"phase\":\"" + Phase + "\",\n  \"mode\":\"continuous_directory_watcher\",\n  \"lower\":\""
			+ JsonEscape(Options.Lower.wstring()) + "\",\n  \"rootFinalPath\":\"" + JsonEscape(Identity.FinalPath)
			+ "\",\n  \"volumeSerial\":" + std::to_string(Identity.VolumeSerial)
			+ ",\n  \"rootFileId\":" + std::to_string(Identity.FileIndex)
			+ ",\n  \"heartbeatAt\":\"" + IsoTimestamp() + "\",\n  \"reason\":\"" + Reason + "\"\n}\n";
	}

	bool Quarantine(const FOptions& Options, const FRootIdentity& Identity, const std::string& Reason,
		const std::wstring& Action, const std::wstring& RelativePath)
	{
		const std::string DetectedAt = IsoTimestamp();
		const std::string Evidence = "{\n  \"version\":2,\n  \"brokerUuid\":\"" + JsonEscape(Options.BrokerUuid)
			+ "\",\n  \"state\":\"quarantined\",\n  \"source\":\"native_directory_watcher\",\n  \"detectedAt\":\""
			+ DetectedAt + "\",\n  \"reason\":\"" + Reason + "\",\n  \"action\":\"" + JsonEscape(Action)
			+ "\",\n  \"path\":\"" + JsonEscape(RelativePath) + "\",\n  \"lower\":\""
			+ JsonEscape(Options.Lower.wstring()) + "\",\n  \"rootFinalPath\":\"" + JsonEscape(Identity.FinalPath)
			+ "\",\n  \"volumeSerial\":" + std::to_string(Identity.VolumeSerial)
			+ ",\n  \"rootFileId\":" + std::to_string(Identity.FileIndex) + "\n}\n";
		return AtomicWrite(Options.Quarantine, Evidence)
			&& AtomicWrite(Options.State, StateJson(Options, Identity, "quarantined", Reason));
	}

	std::wstring ActionName(const DWORD Action)
	{
		switch (Action)
		{
		case FILE_ACTION_ADDED: return L"added";
		case FILE_ACTION_REMOVED: return L"removed";
		case FILE_ACTION_MODIFIED: return L"modified";
		case FILE_ACTION_RENAMED_OLD_NAME: return L"renamed_old_name";
		case FILE_ACTION_RENAMED_NEW_NAME: return L"renamed_new_name";
		default: return L"unknown";
		}
	}

	std::optional<FOptions> ParseOptions(const int ArgumentCount, wchar_t** Arguments)
	{
		FOptions Options;
		for (int Index = 1; Index < ArgumentCount; ++Index)
		{
			const std::wstring Name = Arguments[Index];
			if (Name == L"--test-mode")
			{
				Options.bTestMode = true;
				continue;
			}
			if (Index + 1 >= ArgumentCount)
			{
				return std::nullopt;
			}
			const std::wstring Value = Arguments[++Index];
			if (Name == L"--lower") Options.Lower = Value;
			else if (Name == L"--state") Options.State = Value;
			else if (Name == L"--quarantine") Options.Quarantine = Value;
			else if (Name == L"--broker-uuid") Options.BrokerUuid = Value;
			else if (Name == L"--index") { /* Obsolete compatibility argument; never read or trusted. */ }
			else if (Name == L"--test-failure") Options.TestFailure = Value;
			else return std::nullopt;
		}
		if (Options.Lower.empty() || Options.State.empty() || Options.Quarantine.empty() || Options.BrokerUuid.empty()
			|| (!Options.TestFailure.empty() && !Options.bTestMode))
		{
			return std::nullopt;
		}
		std::error_code Error;
		Options.Lower = std::filesystem::canonical(Options.Lower, Error);
		return Error ? std::nullopt : std::optional<FOptions>(Options);
	}

	bool IsExcludedRelativePath(const std::wstring& RelativePath)
	{
		if (RelativePath.size() < 3 || _wcsnicmp(RelativePath.c_str(), L".vs", 3) != 0)
		{
			return false;
		}
		return RelativePath.size() == 3 || RelativePath[3] == L'\\' || RelativePath[3] == L'/';
	}

	bool ParseEvents(const std::array<std::byte, BufferSize>& Buffer, const DWORD Bytes,
		std::wstring& FirstAction, std::wstring& FirstRelativePath)
	{
		if (Bytes == 0)
		{
			return false;
		}
		DWORD Offset = 0;
		while (true)
		{
			if (Bytes - Offset < offsetof(FILE_NOTIFY_INFORMATION, FileName))
			{
				return false;
			}
			const auto* Information = reinterpret_cast<const FILE_NOTIFY_INFORMATION*>(Buffer.data() + Offset);
			const DWORD HeaderSize = static_cast<DWORD>(offsetof(FILE_NOTIFY_INFORMATION, FileName));
			if ((Information->FileNameLength % sizeof(wchar_t)) != 0
				|| Information->FileNameLength > Bytes - Offset - HeaderSize)
			{
				return false;
			}
			if (Information->Action < FILE_ACTION_ADDED || Information->Action > FILE_ACTION_RENAMED_NEW_NAME)
			{
				return false;
			}
			std::wstring RelativePath(Information->FileName, Information->FileNameLength / sizeof(wchar_t));
			if (RelativePath.empty())
			{
				return false;
			}
			if (FirstRelativePath.empty() && !IsExcludedRelativePath(RelativePath))
			{
				FirstAction = ActionName(Information->Action);
				FirstRelativePath = std::move(RelativePath);
			}
			if (Information->NextEntryOffset == 0)
			{
				return true;
			}
			const DWORD RecordSize = HeaderSize + Information->FileNameLength;
			if ((Information->NextEntryOffset % sizeof(DWORD)) != 0
				|| Information->NextEntryOffset < RecordSize || Information->NextEntryOffset >= Bytes - Offset)
			{
				return false;
			}
			Offset += Information->NextEntryOffset;
		}
	}
}

int wmain(const int ArgumentCount, wchar_t** Arguments)
{
	const std::optional<FOptions> Parsed = ParseOptions(ArgumentCount, Arguments);
	if (!Parsed)
	{
		std::cerr << "usage: lower-freeze-guard --lower PATH --state PATH --quarantine PATH --broker-uuid UUID [--index IGNORED]\n";
		return 2;
	}
	const FOptions& Options = *Parsed;
	FUniqueHandle Directory(CreateFileW(Options.Lower.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
		FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
		FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
	if (Directory.get() == INVALID_HANDLE_VALUE)
	{
		std::cerr << "could not open exact lower directory: " << GetLastError() << '\n';
		return 3;
	}
	const std::optional<FRootIdentity> Identity = GetRootIdentity(Directory.get());
	if (!Identity)
	{
		std::cerr << "could not establish lower root identity\n";
		return 3;
	}
	alignas(DWORD) std::array<std::array<std::byte, BufferSize>, 2> Buffers{};
	std::size_t ActiveBuffer = 0;
	FUniqueHandle Event(CreateEventW(nullptr, TRUE, FALSE, nullptr));
	if (Event.get() == nullptr)
	{
		return 3;
	}
	FDirectoryChangeRead Watch(Directory.get(), Event.get());
	if (!Watch.Arm(Buffers[ActiveBuffer].data(), static_cast<DWORD>(Buffers[ActiveBuffer].size())))
	{
		Quarantine(Options, *Identity, "watch registration failed", L"watcher_error", L"");
		return 4;
	}
	if (!AtomicWrite(Options.State, StateJson(Options, *Identity, "ready")))
	{
		return 4;
	}
	std::cout << "LOWER_FREEZE_READY" << std::endl;

	if (!Options.TestFailure.empty())
	{
		const std::wstring Action = Options.TestFailure == L"overflow" ? L"buffer_overflow" : L"watcher_error";
		const std::string Reason = Options.TestFailure == L"overflow" ? "directory notification buffer overflow" : "simulated watcher error";
		return Quarantine(Options, *Identity, Reason, Action, L"") ? 5 : 6;
	}

	for (;;)
	{
		const DWORD Wait = WaitForSingleObject(Event.get(), 1000);
		if (Wait == WAIT_TIMEOUT)
		{
			if (!IdentityMatches(Directory.get(), *Identity))
			{
				return Quarantine(Options, *Identity, "lower root identity or path changed", L"root_identity_change", L"") ? 5 : 6;
			}
			if (!AtomicWrite(Options.State, StateJson(Options, *Identity, "ready")))
			{
				return Quarantine(Options, *Identity, "heartbeat could not be durably persisted", L"watcher_error", L"") ? 5 : 6;
			}
			continue;
		}
		if (Wait != WAIT_OBJECT_0)
		{
			return Quarantine(Options, *Identity, "watch wait failed", L"watcher_error", L"") ? 5 : 6;
		}
		DWORD Bytes = 0;
		if (!Watch.Complete(Bytes))
		{
			return Quarantine(Options, *Identity, "directory watcher failed", L"watcher_error", L"") ? 5 : 6;
		}
		if (Bytes == 0)
		{
			return Quarantine(Options, *Identity, "directory notification buffer overflow", L"buffer_overflow", L"") ? 5 : 6;
		}

		const std::size_t CompletedBuffer = ActiveBuffer;
		ActiveBuffer = 1 - ActiveBuffer;
		if (!Watch.Arm(Buffers[ActiveBuffer].data(), static_cast<DWORD>(Buffers[ActiveBuffer].size())))
		{
			return Quarantine(Options, *Identity, "watch re-registration failed", L"watcher_error", L"") ? 5 : 6;
		}

		std::wstring Action;
		std::wstring RelativePath;
		if (!ParseEvents(Buffers[CompletedBuffer], Bytes, Action, RelativePath))
		{
			return Quarantine(Options, *Identity, "malformed directory notification", L"malformed_event", L"") ? 5 : 6;
		}
		if (!RelativePath.empty())
		{
			return Quarantine(Options, *Identity, "sealed lower changed", Action, RelativePath) ? 5 : 6;
		}
		if (!IdentityMatches(Directory.get(), *Identity))
		{
			return Quarantine(Options, *Identity, "lower root identity or path changed", L"root_identity_change", L"") ? 5 : 6;
		}
	}
}
