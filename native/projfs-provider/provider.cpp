#include <windows.h>
#include <objbase.h>
#include <projectedfslib.h>
#include <winioctl.h>

#include <algorithm>
#include <atomic>
#include <cstdint>
#include <cwctype>
#include <iostream>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace
{
struct HandleCloser
{
	void operator()(void* Handle) const
	{
		if (Handle != nullptr && Handle != INVALID_HANDLE_VALUE)
		{
			CloseHandle(Handle);
		}
	}
};

using UniqueHandle = std::unique_ptr<void, HandleCloser>;

struct GuidHash
{
	size_t operator()(const GUID& Value) const
	{
		const auto* Bytes = reinterpret_cast<const uint8_t*>(&Value);
		size_t Hash = 1469598103934665603ull;
		for (size_t Index = 0; Index < sizeof(GUID); ++Index)
		{
			Hash = (Hash ^ Bytes[Index]) * 1099511628211ull;
		}
		return Hash;
	}
};

struct GuidEqual
{
	bool operator()(const GUID& Left, const GUID& Right) const
	{
		return InlineIsEqualGUID(Left, Right) != FALSE;
	}
};

struct DirectoryEntry
{
	std::wstring Name;
	PRJ_FILE_BASIC_INFO BasicInfo{};
};

struct EnumerationState
{
	std::wstring RelativePath;
	std::wstring SearchExpression = L"*";
	std::vector<DirectoryEntry> Entries;
	size_t NextIndex = 0;
	bool IsLoaded = false;
};

struct CommandState
{
	std::atomic<bool> IsCancelled = false;
};

class Provider
{
public:
	Provider(std::wstring InLowerPath, std::wstring InRootPath)
		: LowerPath(std::move(InLowerPath)), RootPath(std::move(InRootPath))
	{
	}

	HRESULT Start()
	{
		DWORD RootAttributes = GetFileAttributesW(RootPath.c_str());
		if (RootAttributes == INVALID_FILE_ATTRIBUTES)
		{
			return HRESULT_FROM_WIN32(GetLastError());
		}

		if (!IsProjFsReparsePoint(RootPath))
		{
			if ((RootAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
			{
				return HRESULT_FROM_WIN32(ERROR_REPARSE_TAG_MISMATCH);
			}

			GUID InstanceId{};
			HRESULT Result = CoCreateGuid(&InstanceId);
			if (FAILED(Result))
			{
				return Result;
			}

			Result = PrjMarkDirectoryAsPlaceholder(RootPath.c_str(), nullptr, nullptr, &InstanceId);
			if (FAILED(Result))
			{
				return Result;
			}
		}

		PRJ_CALLBACKS Callbacks{};
		Callbacks.StartDirectoryEnumerationCallback = StartDirectoryEnumeration;
		Callbacks.EndDirectoryEnumerationCallback = EndDirectoryEnumeration;
		Callbacks.GetDirectoryEnumerationCallback = GetDirectoryEnumeration;
		Callbacks.GetPlaceholderInfoCallback = GetPlaceholderInfo;
		Callbacks.GetFileDataCallback = GetFileData;
		Callbacks.QueryFileNameCallback = QueryFileName;
		Callbacks.CancelCommandCallback = CancelCommand;

		PRJ_STARTVIRTUALIZING_OPTIONS Options{};
		Options.ConcurrentThreadCount = 0;
		Options.PoolThreadCount = 0;
		return PrjStartVirtualizing(RootPath.c_str(), &Callbacks, this, &Options, &VirtualizationContext);
	}

	void Stop()
	{
		if (VirtualizationContext != nullptr)
		{
			PrjStopVirtualizing(VirtualizationContext);
			VirtualizationContext = nullptr;
		}
	}

private:
	class CommandScope
	{
	public:
		CommandScope(Provider& InProvider, INT32 InCommandId)
			: Owner(InProvider), CommandId(InCommandId), State(Owner.BeginCommand(CommandId))
		{
		}

		~CommandScope()
		{
			Owner.EndCommand(CommandId, State);
		}

		bool IsCancelled() const
		{
			return State->IsCancelled.load(std::memory_order_relaxed);
		}

	private:
		Provider& Owner;
		INT32 CommandId;
		std::shared_ptr<CommandState> State;
	};

	static Provider& FromCallback(const PRJ_CALLBACK_DATA* CallbackData)
	{
		return *static_cast<Provider*>(CallbackData->InstanceContext);
	}

	static HRESULT CALLBACK StartDirectoryEnumeration(
		const PRJ_CALLBACK_DATA* CallbackData,
		const GUID* EnumerationId)
	{
		Provider& Owner = FromCallback(CallbackData);
		if (!Owner.IsSafeRelativePath(CallbackData->FilePathName))
		{
			return HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED);
		}
		if (Owner.IsExcludedRelativePath(CallbackData->FilePathName))
		{
			return HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);
		}

		std::lock_guard Lock(Owner.EnumerationMutex);
		EnumerationState State;
		State.RelativePath = CallbackData->FilePathName;
		const auto [Iterator, Inserted] = Owner.Enumerations.emplace(*EnumerationId, std::move(State));
		(void)Iterator;
		return Inserted ? S_OK : HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS);
	}

	static HRESULT CALLBACK EndDirectoryEnumeration(
		const PRJ_CALLBACK_DATA* CallbackData,
		const GUID* EnumerationId)
	{
		Provider& Owner = FromCallback(CallbackData);
		std::lock_guard Lock(Owner.EnumerationMutex);
		Owner.Enumerations.erase(*EnumerationId);
		return S_OK;
	}

	static HRESULT CALLBACK GetDirectoryEnumeration(
		const PRJ_CALLBACK_DATA* CallbackData,
		const GUID* EnumerationId,
		PCWSTR SearchExpression,
		PRJ_DIR_ENTRY_BUFFER_HANDLE DirEntryBufferHandle)
	{
		Provider& Owner = FromCallback(CallbackData);
		CommandScope Command(Owner, CallbackData->CommandId);
		std::lock_guard Lock(Owner.EnumerationMutex);

		auto Iterator = Owner.Enumerations.find(*EnumerationId);
		if (Iterator == Owner.Enumerations.end())
		{
			return HRESULT_FROM_WIN32(ERROR_INVALID_PARAMETER);
		}

		EnumerationState& State = Iterator->second;
		if (SearchExpression != nullptr)
		{
			State.SearchExpression = SearchExpression;
		}

		if (!State.IsLoaded || (CallbackData->Flags & PRJ_CB_DATA_FLAG_ENUM_RESTART_SCAN) != 0)
		{
			State.Entries.clear();
			State.NextIndex = 0;
			HRESULT Result = Owner.ReadDirectory(State.RelativePath, State.SearchExpression, State.Entries, Command);
			if (FAILED(Result))
			{
				return Result;
			}
			State.IsLoaded = true;
		}

		while (State.NextIndex < State.Entries.size())
		{
			if (Command.IsCancelled())
			{
				return HRESULT_FROM_WIN32(ERROR_OPERATION_ABORTED);
			}

			DirectoryEntry& Entry = State.Entries[State.NextIndex];
			HRESULT Result = PrjFillDirEntryBuffer(Entry.Name.c_str(), &Entry.BasicInfo, DirEntryBufferHandle);
			if (Result == HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER))
			{
				break;
			}
			if (FAILED(Result))
			{
				return Result;
			}

			++State.NextIndex;
			if ((CallbackData->Flags & PRJ_CB_DATA_FLAG_ENUM_RETURN_SINGLE_ENTRY) != 0)
			{
				break;
			}
		}

		return S_OK;
	}

	static HRESULT CALLBACK GetPlaceholderInfo(const PRJ_CALLBACK_DATA* CallbackData)
	{
		Provider& Owner = FromCallback(CallbackData);
		CommandScope Command(Owner, CallbackData->CommandId);
		if (Command.IsCancelled())
		{
			return HRESULT_FROM_WIN32(ERROR_OPERATION_ABORTED);
		}

		PRJ_PLACEHOLDER_INFO PlaceholderInfo{};
		UniqueHandle LowerHandle;
		HRESULT Result = Owner.ReadBasicInfo(CallbackData->FilePathName, PlaceholderInfo.FileBasicInfo, &LowerHandle);
		if (FAILED(Result))
		{
			return Result;
		}
		std::wstring CanonicalRelativePath;
		Result = Owner.GetCanonicalRelativePath(LowerHandle.get(), CanonicalRelativePath);
		if (FAILED(Result))
		{
			return Result;
		}
		if (Command.IsCancelled())
		{
			return HRESULT_FROM_WIN32(ERROR_OPERATION_ABORTED);
		}

		return PrjWritePlaceholderInfo(
			CallbackData->NamespaceVirtualizationContext,
			CanonicalRelativePath.c_str(),
			&PlaceholderInfo,
			static_cast<UINT32>(sizeof(PlaceholderInfo)));
	}

	static HRESULT CALLBACK GetFileData(
		const PRJ_CALLBACK_DATA* CallbackData,
		UINT64 ByteOffset,
		UINT32 Length)
	{
		Provider& Owner = FromCallback(CallbackData);
		CommandScope Command(Owner, CallbackData->CommandId);
		if (Owner.IsExcludedRelativePath(CallbackData->FilePathName))
		{
			return HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);
		}
		if (Length == 0)
		{
			return S_OK;
		}

		PRJ_FILE_BASIC_INFO BasicInfo{};
		UniqueHandle File;
		HRESULT Result = Owner.ReadBasicInfo(CallbackData->FilePathName, BasicInfo, &File);
		if (FAILED(Result))
		{
			return Result;
		}
		if (BasicInfo.IsDirectory || ByteOffset > static_cast<UINT64>(BasicInfo.FileSize))
		{
			return HRESULT_FROM_WIN32(ERROR_INVALID_PARAMETER);
		}
		const UINT32 BytesToRead = static_cast<UINT32>(std::min<UINT64>(
			Length, static_cast<UINT64>(BasicInfo.FileSize) - ByteOffset));
		if (BytesToRead == 0)
		{
			return S_OK;
		}

		void* Buffer = PrjAllocateAlignedBuffer(CallbackData->NamespaceVirtualizationContext, BytesToRead);
		if (Buffer == nullptr)
		{
			return E_OUTOFMEMORY;
		}

		LARGE_INTEGER Position{};
		Position.QuadPart = static_cast<LONGLONG>(ByteOffset);
		if (!SetFilePointerEx(File.get(), Position, nullptr, FILE_BEGIN))
		{
			Result = HRESULT_FROM_WIN32(GetLastError());
			PrjFreeAlignedBuffer(Buffer);
			return Result;
		}

		UINT32 TotalRead = 0;
		while (TotalRead < BytesToRead)
		{
			if (Command.IsCancelled())
			{
				PrjFreeAlignedBuffer(Buffer);
				return HRESULT_FROM_WIN32(ERROR_OPERATION_ABORTED);
			}

			const DWORD Requested = std::min<DWORD>(BytesToRead - TotalRead, 1024u * 1024u);
			DWORD BytesRead = 0;
			if (!ReadFile(File.get(), static_cast<uint8_t*>(Buffer) + TotalRead, Requested, &BytesRead, nullptr))
			{
				Result = HRESULT_FROM_WIN32(GetLastError());
				PrjFreeAlignedBuffer(Buffer);
				return Result;
			}
			if (BytesRead == 0)
			{
				PrjFreeAlignedBuffer(Buffer);
				return HRESULT_FROM_WIN32(ERROR_HANDLE_EOF);
			}
			TotalRead += BytesRead;
		}

		if (Command.IsCancelled())
		{
			PrjFreeAlignedBuffer(Buffer);
			return HRESULT_FROM_WIN32(ERROR_OPERATION_ABORTED);
		}

		Result = PrjWriteFileData(
			CallbackData->NamespaceVirtualizationContext,
			&CallbackData->DataStreamId,
			Buffer,
			ByteOffset,
			BytesToRead);
		PrjFreeAlignedBuffer(Buffer);
		return Result;
	}

	static HRESULT CALLBACK QueryFileName(const PRJ_CALLBACK_DATA* CallbackData)
	{
		Provider& Owner = FromCallback(CallbackData);
		CommandScope Command(Owner, CallbackData->CommandId);
		if (Command.IsCancelled())
		{
			return HRESULT_FROM_WIN32(ERROR_OPERATION_ABORTED);
		}

		PRJ_FILE_BASIC_INFO BasicInfo{};
		return Owner.ReadBasicInfo(CallbackData->FilePathName, BasicInfo, nullptr);
	}

	static void CALLBACK CancelCommand(const PRJ_CALLBACK_DATA* CallbackData)
	{
		Provider& Owner = FromCallback(CallbackData);
		std::lock_guard Lock(Owner.CommandMutex);
		auto Iterator = Owner.Commands.find(CallbackData->CommandId);
		if (Iterator != Owner.Commands.end())
		{
			Iterator->second->IsCancelled.store(true, std::memory_order_relaxed);
		}
	}

	std::shared_ptr<CommandState> BeginCommand(INT32 CommandId)
	{
		auto State = std::make_shared<CommandState>();
		std::lock_guard Lock(CommandMutex);
		Commands[CommandId] = State;
		return State;
	}

	void EndCommand(INT32 CommandId, const std::shared_ptr<CommandState>& State)
	{
		std::lock_guard Lock(CommandMutex);
		auto Iterator = Commands.find(CommandId);
		if (Iterator != Commands.end() && Iterator->second == State)
		{
			Commands.erase(Iterator);
		}
	}

	HRESULT ReadDirectory(
		const std::wstring& RelativePath,
		const std::wstring& SearchExpression,
		std::vector<DirectoryEntry>& Entries,
		const CommandScope& Command) const
	{
		UniqueHandle Directory;
		PRJ_FILE_BASIC_INFO DirectoryInfo{};
		HRESULT Result = ReadBasicInfo(RelativePath.c_str(), DirectoryInfo, &Directory);
		if (FAILED(Result))
		{
			return Result;
		}
		if (!DirectoryInfo.IsDirectory)
		{
			return HRESULT_FROM_WIN32(ERROR_DIRECTORY);
		}

		std::wstring SearchPath = MakeLowerPath(RelativePath.c_str());
		SearchPath += SearchPath.back() == L'\\' ? L"*" : L"\\*";
		WIN32_FIND_DATAW FindData{};
		HANDLE RawFindHandle = FindFirstFileExW(
			SearchPath.c_str(), FindExInfoBasic, &FindData, FindExSearchNameMatch, nullptr, FIND_FIRST_EX_LARGE_FETCH);
		if (RawFindHandle == INVALID_HANDLE_VALUE)
		{
			const DWORD Error = GetLastError();
			return Error == ERROR_FILE_NOT_FOUND ? S_OK : HRESULT_FROM_WIN32(Error);
		}

		do
		{
			if (Command.IsCancelled())
			{
				FindClose(RawFindHandle);
				return HRESULT_FROM_WIN32(ERROR_OPERATION_ABORTED);
			}
			if (wcscmp(FindData.cFileName, L".") == 0 || wcscmp(FindData.cFileName, L"..") == 0)
			{
				continue;
			}
			if ((FindData.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
			{
				continue;
			}
			if (RelativePath.empty() && IsExcludedRelativePath(FindData.cFileName))
			{
				continue;
			}
			if (!PrjFileNameMatch(FindData.cFileName, SearchExpression.c_str()))
			{
				continue;
			}

			DirectoryEntry Entry;
			Entry.Name = FindData.cFileName;
			Entry.BasicInfo.IsDirectory = (FindData.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
			Entry.BasicInfo.FileSize = Entry.BasicInfo.IsDirectory ? 0 :
				(static_cast<INT64>(FindData.nFileSizeHigh) << 32) | FindData.nFileSizeLow;
			Entry.BasicInfo.CreationTime = ToLargeInteger(FindData.ftCreationTime);
			Entry.BasicInfo.LastAccessTime = ToLargeInteger(FindData.ftLastAccessTime);
			Entry.BasicInfo.LastWriteTime = ToLargeInteger(FindData.ftLastWriteTime);
			Entry.BasicInfo.ChangeTime = Entry.BasicInfo.LastWriteTime;
			Entry.BasicInfo.FileAttributes = FindData.dwFileAttributes & ~FILE_ATTRIBUTE_REPARSE_POINT;
			Entries.push_back(std::move(Entry));
		} while (FindNextFileW(RawFindHandle, &FindData));

		const DWORD FindError = GetLastError();
		FindClose(RawFindHandle);
		if (FindError != ERROR_NO_MORE_FILES)
		{
			return HRESULT_FROM_WIN32(FindError);
		}

		std::sort(Entries.begin(), Entries.end(), [](const DirectoryEntry& Left, const DirectoryEntry& Right)
		{
			return PrjFileNameCompare(Left.Name.c_str(), Right.Name.c_str()) < 0;
		});
		return S_OK;
	}

	HRESULT ReadBasicInfo(
		PCWSTR RelativePath,
		PRJ_FILE_BASIC_INFO& BasicInfo,
		UniqueHandle* OpenedHandle) const
	{
		if (!IsSafeRelativePath(RelativePath))
		{
			return HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED);
		}
		if (IsExcludedRelativePath(RelativePath))
		{
			return HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND);
		}

		const std::wstring FullPath = MakeLowerPath(RelativePath);
		HRESULT Result = ValidateNoReparseComponents(FullPath);
		if (FAILED(Result))
		{
			return Result;
		}

		UniqueHandle Handle(CreateFileW(
			FullPath.c_str(),
			GENERIC_READ,
			FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
			nullptr,
			OPEN_EXISTING,
			FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN,
			nullptr));
		if (Handle.get() == INVALID_HANDLE_VALUE)
		{
			return HRESULT_FROM_WIN32(GetLastError());
		}

		std::wstring FinalPath;
		Result = GetFinalPath(Handle.get(), FinalPath);
		if (FAILED(Result))
		{
			return Result;
		}
		if (!IsPathEqualOrInside(FinalPath, LowerFinalPath))
		{
			return HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED);
		}

		FILE_BASIC_INFO NativeBasicInfo{};
		FILE_STANDARD_INFO NativeStandardInfo{};
		if (!GetFileInformationByHandleEx(Handle.get(), FileBasicInfo, &NativeBasicInfo, sizeof(NativeBasicInfo)) ||
			!GetFileInformationByHandleEx(Handle.get(), FileStandardInfo, &NativeStandardInfo, sizeof(NativeStandardInfo)))
		{
			return HRESULT_FROM_WIN32(GetLastError());
		}
		if ((NativeBasicInfo.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
		{
			return HRESULT_FROM_WIN32(ERROR_REPARSE_POINT_ENCOUNTERED);
		}

		BasicInfo.IsDirectory = NativeStandardInfo.Directory;
		BasicInfo.FileSize = BasicInfo.IsDirectory ? 0 : NativeStandardInfo.EndOfFile.QuadPart;
		BasicInfo.CreationTime = NativeBasicInfo.CreationTime;
		BasicInfo.LastAccessTime = NativeBasicInfo.LastAccessTime;
		BasicInfo.LastWriteTime = NativeBasicInfo.LastWriteTime;
		BasicInfo.ChangeTime = NativeBasicInfo.ChangeTime;
		BasicInfo.FileAttributes = NativeBasicInfo.FileAttributes & ~FILE_ATTRIBUTE_REPARSE_POINT;

		if (OpenedHandle != nullptr)
		{
			*OpenedHandle = std::move(Handle);
		}
		return S_OK;
	}

	HRESULT GetCanonicalRelativePath(HANDLE LowerHandle, std::wstring& RelativePath) const
	{
		std::wstring FinalPath;
		HRESULT Result = GetFinalPath(LowerHandle, FinalPath);
		if (FAILED(Result))
		{
			return Result;
		}
		if (!IsPathEqualOrInside(FinalPath, LowerFinalPath))
		{
			return HRESULT_FROM_WIN32(ERROR_ACCESS_DENIED);
		}
		if (FinalPath.size() == LowerFinalPath.size())
		{
			RelativePath.clear();
			return S_OK;
		}
		RelativePath = FinalPath.substr(LowerFinalPath.size() + 1);
		return S_OK;
	}

	static bool IsExcludedRelativePath(PCWSTR RelativePath)
	{
		if (RelativePath == nullptr || _wcsnicmp(RelativePath, L".vs", 3) != 0)
		{
			return false;
		}
		return RelativePath[3] == L'\0' || RelativePath[3] == L'\\' || RelativePath[3] == L'/';
	}

	bool IsSafeRelativePath(PCWSTR RelativePath) const
	{
		if (RelativePath == nullptr)
		{
			return false;
		}
		if (RelativePath[0] == L'\\' || RelativePath[0] == L'/' || wcschr(RelativePath, L':') != nullptr)
		{
			return false;
		}

		std::wstring Component;
		for (const wchar_t* Cursor = RelativePath;; ++Cursor)
		{
			if (*Cursor != L'\\' && *Cursor != L'/' && *Cursor != L'\0')
			{
				Component.push_back(*Cursor);
				continue;
			}
			if (Component == L"." || Component == L"..")
			{
				return false;
			}
			Component.clear();
			if (*Cursor == L'\0')
			{
				break;
			}
		}
		return true;
	}

	HRESULT ValidateNoReparseComponents(const std::wstring& FullPath) const
	{
		if (FullPath.size() < LowerPath.size())
		{
			return E_INVALIDARG;
		}

		size_t Cursor = LowerPath.size();
		while (Cursor < FullPath.size())
		{
			while (Cursor < FullPath.size() && (FullPath[Cursor] == L'\\' || FullPath[Cursor] == L'/'))
			{
				++Cursor;
			}
			if (Cursor == FullPath.size())
			{
				break;
			}
			const size_t Separator = FullPath.find_first_of(L"\\/", Cursor);
			const std::wstring Prefix = FullPath.substr(0, Separator);
			const DWORD Attributes = GetFileAttributesW(Prefix.c_str());
			if (Attributes == INVALID_FILE_ATTRIBUTES)
			{
				return HRESULT_FROM_WIN32(GetLastError());
			}
			if ((Attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
			{
				return HRESULT_FROM_WIN32(ERROR_REPARSE_POINT_ENCOUNTERED);
			}
			if (Separator == std::wstring::npos)
			{
				break;
			}
			Cursor = Separator + 1;
		}
		return S_OK;
	}

	std::wstring MakeLowerPath(PCWSTR RelativePath) const
	{
		if (RelativePath == nullptr || RelativePath[0] == L'\0')
		{
			return LowerPath;
		}
		return LowerPath + L"\\" + RelativePath;
	}

	static LARGE_INTEGER ToLargeInteger(const FILETIME& Time)
	{
		LARGE_INTEGER Result{};
		Result.LowPart = Time.dwLowDateTime;
		Result.HighPart = static_cast<LONG>(Time.dwHighDateTime);
		return Result;
	}

	static HRESULT GetFinalPath(HANDLE Handle, std::wstring& FinalPath)
	{
		const DWORD Length = GetFinalPathNameByHandleW(Handle, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
		if (Length == 0)
		{
			return HRESULT_FROM_WIN32(GetLastError());
		}

		std::wstring Buffer(Length, L'\0');
		const DWORD Written = GetFinalPathNameByHandleW(
			Handle, Buffer.data(), static_cast<DWORD>(Buffer.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
		if (Written == 0 || Written >= Buffer.size())
		{
			return HRESULT_FROM_WIN32(Written == 0 ? GetLastError() : ERROR_INSUFFICIENT_BUFFER);
		}
		Buffer.resize(Written);
		FinalPath = NormalizePath(Buffer);
		return S_OK;
	}

	static std::wstring NormalizePath(std::wstring Path)
	{
		if (Path.starts_with(L"\\\\?\\"))
		{
			Path.erase(0, 4);
		}
		while (Path.size() > 3 && (Path.back() == L'\\' || Path.back() == L'/'))
		{
			Path.pop_back();
		}
		std::replace(Path.begin(), Path.end(), L'/', L'\\');
		return Path;
	}

	static bool IsPathEqualOrInside(const std::wstring& Candidate, const std::wstring& Parent)
	{
		if (_wcsicmp(Candidate.c_str(), Parent.c_str()) == 0)
		{
			return true;
		}
		if (Candidate.size() <= Parent.size() || Candidate[Parent.size()] != L'\\')
		{
			return false;
		}
		return _wcsnicmp(Candidate.c_str(), Parent.c_str(), Parent.size()) == 0;
	}

	static bool IsProjFsReparsePoint(const std::wstring& Path)
	{
		UniqueHandle Handle(CreateFileW(
			Path.c_str(), 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
			FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
		if (Handle.get() == INVALID_HANDLE_VALUE)
		{
			return false;
		}

		std::vector<uint8_t> Buffer(MAXIMUM_REPARSE_DATA_BUFFER_SIZE);
		DWORD BytesReturned = 0;
		if (!DeviceIoControl(
			Handle.get(), FSCTL_GET_REPARSE_POINT, nullptr, 0, Buffer.data(),
			static_cast<DWORD>(Buffer.size()), &BytesReturned, nullptr))
		{
			return false;
		}
		if (BytesReturned < sizeof(ULONG))
		{
			return false;
		}
		return *reinterpret_cast<const ULONG*>(Buffer.data()) == IO_REPARSE_TAG_PROJFS;
	}

	std::wstring LowerPath;
	std::wstring RootPath;
	std::wstring LowerFinalPath;
	PRJ_NAMESPACE_VIRTUALIZATION_CONTEXT VirtualizationContext = nullptr;
	std::mutex EnumerationMutex;
	std::unordered_map<GUID, EnumerationState, GuidHash, GuidEqual> Enumerations;
	std::mutex CommandMutex;
	std::unordered_map<INT32, std::shared_ptr<CommandState>> Commands;

public:
	HRESULT InitializeLowerFinalPath()
	{
		UniqueHandle Handle(CreateFileW(
			LowerPath.c_str(), GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
			OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
		if (Handle.get() == INVALID_HANDLE_VALUE)
		{
			return HRESULT_FROM_WIN32(GetLastError());
		}
		return GetFinalPath(Handle.get(), LowerFinalPath);
	}
};

HANDLE StopEvent = nullptr;

BOOL WINAPI ConsoleControlHandler(DWORD ControlType)
{
	if (ControlType != CTRL_C_EVENT && ControlType != CTRL_BREAK_EVENT &&
		ControlType != CTRL_CLOSE_EVENT && ControlType != CTRL_SHUTDOWN_EVENT)
	{
		return FALSE;
	}
	if (StopEvent != nullptr)
	{
		SetEvent(StopEvent);
	}
	return TRUE;
}

bool IsDriveAbsolutePath(const std::wstring& Path)
{
	return Path.size() >= 3 && iswalpha(Path[0]) && Path[1] == L':' &&
		(Path[2] == L'\\' || Path[2] == L'/');
}

HRESULT CanonicalizeExistingDirectory(const std::wstring& Input, std::wstring& Output, bool AllowProjFsRoot)
{
	if (!IsDriveAbsolutePath(Input) || Input.starts_with(L"\\\\?\\"))
	{
		return E_INVALIDARG;
	}

	const DWORD Length = GetFullPathNameW(Input.c_str(), 0, nullptr, nullptr);
	if (Length == 0)
	{
		return HRESULT_FROM_WIN32(GetLastError());
	}
	std::wstring FullPath(Length, L'\0');
	const DWORD Written = GetFullPathNameW(Input.c_str(), Length, FullPath.data(), nullptr);
	if (Written == 0 || Written >= Length)
	{
		return HRESULT_FROM_WIN32(Written == 0 ? GetLastError() : ERROR_INSUFFICIENT_BUFFER);
	}
	FullPath.resize(Written);
	while (FullPath.size() > 3 && (FullPath.back() == L'\\' || FullPath.back() == L'/'))
	{
		FullPath.pop_back();
	}

	const DWORD Attributes = GetFileAttributesW(FullPath.c_str());
	if (Attributes == INVALID_FILE_ATTRIBUTES)
	{
		return HRESULT_FROM_WIN32(GetLastError());
	}
	if ((Attributes & FILE_ATTRIBUTE_DIRECTORY) == 0)
	{
		return HRESULT_FROM_WIN32(ERROR_DIRECTORY);
	}
	if ((Attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 && !AllowProjFsRoot)
	{
		return HRESULT_FROM_WIN32(ERROR_REPARSE_POINT_ENCOUNTERED);
	}

	Output = std::move(FullPath);
	return S_OK;
}

HRESULT ResolveFinalDirectoryPath(const std::wstring& Path, std::wstring& FinalPath)
{
	UniqueHandle Handle(CreateFileW(
		Path.c_str(), 0, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr,
		OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
	if (Handle.get() == INVALID_HANDLE_VALUE)
	{
		return HRESULT_FROM_WIN32(GetLastError());
	}

	const DWORD Length = GetFinalPathNameByHandleW(
		Handle.get(), nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
	if (Length == 0)
	{
		return HRESULT_FROM_WIN32(GetLastError());
	}

	std::wstring Buffer(Length, L'\0');
	const DWORD Written = GetFinalPathNameByHandleW(
		Handle.get(), Buffer.data(), Length, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
	if (Written == 0 || Written >= Length)
	{
		return HRESULT_FROM_WIN32(Written == 0 ? GetLastError() : ERROR_INSUFFICIENT_BUFFER);
	}
	Buffer.resize(Written);
	if (Buffer.starts_with(L"\\\\?\\"))
	{
		Buffer.erase(0, 4);
	}
	while (Buffer.size() > 3 && (Buffer.back() == L'\\' || Buffer.back() == L'/'))
	{
		Buffer.pop_back();
	}
	std::replace(Buffer.begin(), Buffer.end(), L'/', L'\\');
	FinalPath = std::move(Buffer);
	return S_OK;
}

bool PathsOverlap(const std::wstring& Left, const std::wstring& Right)
{
	if (_wcsicmp(Left.c_str(), Right.c_str()) == 0)
	{
		return true;
	}
	if (Left.size() > Right.size() && Left[Right.size()] == L'\\' &&
		_wcsnicmp(Left.c_str(), Right.c_str(), Right.size()) == 0)
	{
		return true;
	}
	return Right.size() > Left.size() && Right[Left.size()] == L'\\' &&
		_wcsnicmp(Right.c_str(), Left.c_str(), Left.size()) == 0;
}

void PrintUsage()
{
	std::wcerr << L"Usage: projfs-provider.exe --lower <absolute-dir> --root <absolute-dir>\n";
}
}

int wmain(int ArgumentCount, wchar_t** Arguments)
{
	std::wstring LowerInput;
	std::wstring RootInput;
	for (int Index = 1; Index < ArgumentCount; ++Index)
	{
		if (wcscmp(Arguments[Index], L"--lower") == 0 && Index + 1 < ArgumentCount)
		{
			LowerInput = Arguments[++Index];
			continue;
		}
		if (wcscmp(Arguments[Index], L"--root") == 0 && Index + 1 < ArgumentCount)
		{
			RootInput = Arguments[++Index];
			continue;
		}
		PrintUsage();
		return 2;
	}
	if (LowerInput.empty() || RootInput.empty())
	{
		PrintUsage();
		return 2;
	}

	std::wstring LowerPath;
	std::wstring RootPath;
	HRESULT Result = CanonicalizeExistingDirectory(LowerInput, LowerPath, false);
	if (FAILED(Result))
	{
		std::wcerr << L"Invalid lower directory (0x" << std::hex << Result << L").\n";
		return 1;
	}
	Result = CanonicalizeExistingDirectory(RootInput, RootPath, true);
	if (FAILED(Result))
	{
		std::wcerr << L"Invalid root directory (0x" << std::hex << Result << L").\n";
		return 1;
	}
	std::wstring LowerFinalPath;
	std::wstring RootFinalPath;
	Result = ResolveFinalDirectoryPath(LowerPath, LowerFinalPath);
	if (FAILED(Result))
	{
		std::wcerr << L"Could not resolve lower directory (0x" << std::hex << Result << L").\n";
		return 1;
	}
	Result = ResolveFinalDirectoryPath(RootPath, RootFinalPath);
	if (FAILED(Result))
	{
		std::wcerr << L"Could not resolve root directory (0x" << std::hex << Result << L").\n";
		return 1;
	}
	if (PathsOverlap(LowerPath, RootPath) || PathsOverlap(LowerFinalPath, RootFinalPath))
	{
		std::wcerr << L"Lower and root directories must not overlap.\n";
		return 1;
	}

	Provider Instance(std::move(LowerPath), std::move(RootPath));
	Result = Instance.InitializeLowerFinalPath();
	if (FAILED(Result))
	{
		std::wcerr << L"Could not resolve lower directory (0x" << std::hex << Result << L").\n";
		return 1;
	}

	StopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
	if (StopEvent == nullptr)
	{
		std::wcerr << L"Could not create stop event.\n";
		return 1;
	}
	UniqueHandle StopEventHandle(StopEvent);
	if (!SetConsoleCtrlHandler(ConsoleControlHandler, TRUE))
	{
		std::wcerr << L"Could not install console control handler.\n";
		return 1;
	}

	Result = Instance.Start();
	if (FAILED(Result))
	{
		std::wcerr << L"PrjStartVirtualizing failed (0x" << std::hex << Result << L").\n";
		return 1;
	}

	std::wcout << L"PROJFS_READY" << std::endl;
	WaitForSingleObject(StopEvent, INFINITE);
	Instance.Stop();
	SetConsoleCtrlHandler(ConsoleControlHandler, FALSE);
	StopEvent = nullptr;
	return 0;
}
