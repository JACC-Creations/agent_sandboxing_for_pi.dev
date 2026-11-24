#include <windows.h>

#include <chrono>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <map>
#include <memory>
#include <sstream>
#include <string>
#include <thread>
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

std::wstring QuoteArgument(const std::wstring& Value)
{
	if (Value.find_first_of(L" \t\"") == std::wstring::npos && !Value.empty())
	{
		return Value;
	}
	std::wstring Result = L"\"";
	size_t Backslashes = 0;
	for (const wchar_t Character : Value)
	{
		if (Character == L'\\')
		{
			++Backslashes;
			continue;
		}
		if (Character == L'\"')
		{
			Result.append(Backslashes * 2 + 1, L'\\');
			Result.push_back(L'\"');
			Backslashes = 0;
			continue;
		}
		Result.append(Backslashes, L'\\');
		Backslashes = 0;
		Result.push_back(Character);
	}
	Result.append(Backslashes * 2, L'\\');
	Result.push_back(L'\"');
	return Result;
}

std::string Utf8(const std::wstring& Value)
{
	if (Value.empty())
	{
		return {};
	}
	const int Size = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, Value.data(), static_cast<int>(Value.size()), nullptr, 0, nullptr, nullptr);
	if (Size <= 0)
	{
		throw std::runtime_error("invalid UTF-16 argument");
	}
	std::string Result(static_cast<size_t>(Size), '\0');
	if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, Value.data(), static_cast<int>(Value.size()), Result.data(), Size, nullptr, nullptr) != Size)
	{
		throw std::runtime_error("UTF-8 conversion failed");
	}
	return Result;
}

std::string EscapeJson(const std::wstring& Value)
{
	std::ostringstream Result;
	for (const unsigned char Character : Utf8(Value))
	{
		switch (Character)
		{
		case '\\': Result << "\\\\"; break;
		case '"': Result << "\\\""; break;
		case '\n': Result << "\\n"; break;
		case '\r': Result << "\\r"; break;
		case '\t': Result << "\\t"; break;
		default:
			if (Character < 0x20)
			{
				Result << "\\u00" << "0123456789abcdef"[(Character >> 4) & 0xf] << "0123456789abcdef"[Character & 0xf];
			}
			else
			{
				Result << Character;
			}
		}
	}
	return Result.str();
}

uint64_t FileTimeValue(const FILETIME& Value)
{
	ULARGE_INTEGER Converted{};
	Converted.LowPart = Value.dwLowDateTime;
	Converted.HighPart = Value.dwHighDateTime;
	return Converted.QuadPart;
}

void WriteManifest(const std::wstring& Path, const std::wstring& Owner, const std::wstring& Nonce,
	const std::wstring& Kind, const std::wstring& JobName, DWORD Pid, uint64_t Identity,
	const char* State, const DWORD* ExitCode)
{
	const std::filesystem::path FinalPath(Path);
	const std::filesystem::path TemporaryPath = FinalPath.wstring() + L".tmp." + std::to_wstring(GetCurrentProcessId());
	std::ostringstream Json;
	Json << "{\n"
		<< "  \"version\": 1,\n"
		<< "  \"ownerUuid\": \"" << EscapeJson(Owner) << "\",\n"
		<< "  \"nonce\": \"" << EscapeJson(Nonce) << "\",\n"
		<< "  \"kind\": \"" << EscapeJson(Kind) << "\",\n"
		<< "  \"jobName\": \"" << EscapeJson(JobName) << "\",\n"
		<< "  \"pid\": " << Pid << ",\n"
		<< "  \"creationIdentity\": \"win:" << Identity << "\",\n"
		<< "  \"supervisorPid\": " << GetCurrentProcessId() << ",\n"
		<< "  \"state\": \"" << State << "\"";
	if (ExitCode != nullptr)
	{
		Json << ",\n  \"exitCode\": " << *ExitCode;
	}
	Json << "\n}\n";
	const std::string Contents = Json.str();
	UniqueHandle File(CreateFileW(TemporaryPath.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS,
		FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH, nullptr));
	if (File.get() == INVALID_HANDLE_VALUE)
	{
		throw std::runtime_error("could not create launch manifest");
	}
	DWORD Written = 0;
	if (!WriteFile(File.get(), Contents.data(), static_cast<DWORD>(Contents.size()), &Written, nullptr)
		|| Written != static_cast<DWORD>(Contents.size()) || !FlushFileBuffers(File.get()))
	{
		throw std::runtime_error("could not durably write launch manifest");
	}
	File.reset();
	if (!MoveFileExW(TemporaryPath.c_str(), FinalPath.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
	{
		DeleteFileW(TemporaryPath.c_str());
		throw std::runtime_error("could not install launch manifest");
	}
}

std::map<std::wstring, std::wstring> ParseOptions(int argc, wchar_t** argv, int Start, int& Separator)
{
	std::map<std::wstring, std::wstring> Result;
	Separator = argc;
	for (int Index = Start; Index < argc; ++Index)
	{
		if (std::wstring(argv[Index]) == L"--")
		{
			Separator = Index;
			break;
		}
		if (Index + 1 >= argc || std::wstring(argv[Index]).rfind(L"--", 0) != 0)
		{
			throw std::runtime_error("invalid arguments");
		}
		const std::wstring Name = std::wstring(argv[Index]).substr(2);
		++Index;
		Result.emplace(Name, argv[Index]);
	}
	return Result;
}

int DurableReplace(int argc, wchar_t** argv)
{
	int Separator = argc;
	const auto Options = ParseOptions(argc, argv, 2, Separator);
	if (argc != 6 || Separator != argc || Options.size() != 2 || !Options.contains(L"source") || !Options.contains(L"target"))
	{
		throw std::runtime_error("durable-replace requires --source and --target");
	}

	const std::filesystem::path Source = std::filesystem::path(Options.at(L"source")).lexically_normal();
	const std::filesystem::path Target = std::filesystem::path(Options.at(L"target")).lexically_normal();
	if (!Source.is_absolute() || !Target.is_absolute() || Source.filename().empty() || Target.filename().empty())
	{
		throw std::runtime_error("durable-replace paths must be absolute files");
	}
	if (CompareStringOrdinal(Source.c_str(), -1, Target.c_str(), -1, TRUE) == CSTR_EQUAL
		|| CompareStringOrdinal(Source.parent_path().c_str(), -1, Target.parent_path().c_str(), -1, TRUE) != CSTR_EQUAL)
	{
		throw std::runtime_error("durable-replace paths must be distinct and in one directory");
	}

	const DWORD SourceAttributes = GetFileAttributesW(Source.c_str());
	if (SourceAttributes == INVALID_FILE_ATTRIBUTES || (SourceAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0
		|| (SourceAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)
	{
		throw std::runtime_error("durable-replace source must be an existing regular file");
	}
	const DWORD TargetAttributes = GetFileAttributesW(Target.c_str());
	if (TargetAttributes != INVALID_FILE_ATTRIBUTES && ((TargetAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0
		|| (TargetAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0))
	{
		throw std::runtime_error("durable-replace target must be a regular file or absent");
	}
	for (DWORD Attempt = 0; Attempt <= 20; ++Attempt)
	{
		if (MoveFileExW(Source.c_str(), Target.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH))
		{
			return 0;
		}
		const DWORD Error = GetLastError();
		if ((Error != ERROR_ACCESS_DENIED && Error != ERROR_SHARING_VIOLATION && Error != ERROR_LOCK_VIOLATION) || Attempt == 20)
		{
			throw std::runtime_error("durable-replace failed with Windows error " + std::to_string(Error));
		}
		std::this_thread::sleep_for(std::chrono::milliseconds(10 * (Attempt + 1)));
	}
	throw std::runtime_error("durable-replace failed");
}

DWORD TestPublicationDelayMs()
{
	wchar_t Buffer[32]{};
	const DWORD Length = GetEnvironmentVariableW(L"AGENT_WORKSPACE_TEST_NATIVE_PUBLICATION_DELAY_MS", Buffer, static_cast<DWORD>(std::size(Buffer)));
	if (Length == 0 || Length >= std::size(Buffer))
	{
		return 0;
	}
	return static_cast<DWORD>(std::stoul(Buffer));
}

DWORD ParseTimeout(const std::map<std::wstring, std::wstring>& Options, const wchar_t* Name, DWORD DefaultValue)
{
	const auto Iterator = Options.find(Name);
	if (Iterator == Options.end())
	{
		return DefaultValue;
	}
	const unsigned long Value = std::stoul(Iterator->second);
	if (Value == 0 || Value > 600000)
	{
		throw std::runtime_error(Utf8(Name) + " is out of range");
	}
	return static_cast<DWORD>(Value);
}

const std::wstring& Require(const std::map<std::wstring, std::wstring>& Options, const wchar_t* Name)
{
	const auto Iterator = Options.find(Name);
	if (Iterator == Options.end() || Iterator->second.empty())
	{
		throw std::runtime_error("missing required option: " + Utf8(Name));
	}
	return Iterator->second;
}

bool ManifestContains(const std::wstring& Path, const std::wstring& Name, const std::wstring& Value)
{
	std::ifstream Input(std::filesystem::path(Path), std::ios::binary);
	const std::string Contents((std::istreambuf_iterator<char>(Input)), std::istreambuf_iterator<char>());
	const std::string Expected = "\"" + Utf8(Name) + "\": \"" + EscapeJson(Value) + "\"";
	return Contents.find(Expected) != std::string::npos;
}

int Launch(int argc, wchar_t** argv)
{
	int Separator = 0;
	const auto Options = ParseOptions(argc, argv, 2, Separator);
	if (Separator + 1 >= argc)
	{
		throw std::runtime_error("launch requires an executable after --");
	}
	const std::wstring& Manifest = Require(Options, L"manifest");
	const std::wstring& Owner = Require(Options, L"owner");
	const std::wstring& Nonce = Require(Options, L"nonce");
	const std::wstring& Kind = Require(Options, L"kind");
	const std::wstring& JobName = Require(Options, L"job-name");
	const std::wstring& Commit = Require(Options, L"commit");
	const DWORD CommitTimeoutMs = ParseTimeout(Options, L"commit-timeout-ms", 10000);
	const std::wstring& WorkingDirectory = Require(Options, L"cwd");
	const std::wstring& StdoutPath = Require(Options, L"stdout");
	const std::wstring& StderrPath = Require(Options, L"stderr");

	UniqueHandle Job(CreateJobObjectW(nullptr, JobName.c_str()));
	if (Job.get() == nullptr || GetLastError() == ERROR_ALREADY_EXISTS)
	{
		throw std::runtime_error("could not create a new uniquely named ownership job");
	}
	JOBOBJECT_EXTENDED_LIMIT_INFORMATION Limits{};
	Limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
	if (!SetInformationJobObject(Job.get(), JobObjectExtendedLimitInformation, &Limits, sizeof(Limits)))
	{
		throw std::runtime_error("could not configure ownership job");
	}
	UniqueHandle StandardInput(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
		nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr));
	UniqueHandle StandardOutput(CreateFileW(StdoutPath.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
		nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
	UniqueHandle StandardError(CreateFileW(StderrPath.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ | FILE_SHARE_WRITE,
		nullptr, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
	if (StandardInput.get() == INVALID_HANDLE_VALUE || StandardOutput.get() == INVALID_HANDLE_VALUE || StandardError.get() == INVALID_HANDLE_VALUE)
	{
		throw std::runtime_error("could not open owned process standard handles");
	}
	if (!SetHandleInformation(StandardInput.get(), HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)
		|| !SetHandleInformation(StandardOutput.get(), HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)
		|| !SetHandleInformation(StandardError.get(), HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT))
	{
		throw std::runtime_error("could not mark owned process standard handles inheritable");
	}

	std::wstring CommandLine;
	for (int Index = Separator + 1; Index < argc; ++Index)
	{
		if (!CommandLine.empty()) CommandLine.push_back(L' ');
		CommandLine += QuoteArgument(argv[Index]);
	}
	std::vector<wchar_t> WritableCommandLine(CommandLine.begin(), CommandLine.end());
	WritableCommandLine.push_back(L'\0');
	SIZE_T AttributeBytes = 0;
	InitializeProcThreadAttributeList(nullptr, 1, 0, &AttributeBytes);
	if (AttributeBytes == 0)
	{
		throw std::runtime_error("could not size process attribute list");
	}
	std::vector<std::byte> AttributeStorage(AttributeBytes);
	STARTUPINFOEXW Startup{};
	Startup.StartupInfo.cb = sizeof(Startup);
	Startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
	Startup.StartupInfo.wShowWindow = SW_HIDE;
	Startup.StartupInfo.hStdInput = StandardInput.get();
	Startup.StartupInfo.hStdOutput = StandardOutput.get();
	Startup.StartupInfo.hStdError = StandardError.get();
	Startup.lpAttributeList = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(AttributeStorage.data());
	if (!InitializeProcThreadAttributeList(Startup.lpAttributeList, 1, 0, &AttributeBytes))
	{
		throw std::runtime_error("could not initialize process attribute list");
	}
	struct AttributeListDeleter
	{
		LPPROC_THREAD_ATTRIBUTE_LIST Value;
		~AttributeListDeleter() { DeleteProcThreadAttributeList(Value); }
	} AttributeListScope{Startup.lpAttributeList};
	HANDLE InheritedHandles[] = {StandardInput.get(), StandardOutput.get(), StandardError.get()};
	if (!UpdateProcThreadAttribute(Startup.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
		InheritedHandles, sizeof(InheritedHandles), nullptr, nullptr))
	{
		throw std::runtime_error("could not set explicit inherited handle list");
	}
	PROCESS_INFORMATION Process{};
	if (!CreateProcessW(argv[Separator + 1], WritableCommandLine.data(), nullptr, nullptr, TRUE,
		CREATE_SUSPENDED | CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT, nullptr,
		WorkingDirectory.c_str(), &Startup.StartupInfo, &Process))
	{
		throw std::runtime_error("could not create suspended child");
	}
	UniqueHandle ChildProcess(Process.hProcess);
	UniqueHandle ChildThread(Process.hThread);
	if (!AssignProcessToJobObject(Job.get(), ChildProcess.get()))
	{
		TerminateProcess(ChildProcess.get(), ERROR_PROCESS_ABORTED);
		throw std::runtime_error("could not assign suspended child to ownership job");
	}
	FILETIME Created{}, Exited{}, Kernel{}, User{};
	if (!GetProcessTimes(ChildProcess.get(), &Created, &Exited, &Kernel, &User) || FileTimeValue(Created) == 0)
	{
		TerminateJobObject(Job.get(), ERROR_PROCESS_ABORTED);
		throw std::runtime_error("could not obtain non-null child creation identity");
	}
	const DWORD PublicationDelayMs = TestPublicationDelayMs();
	if (PublicationDelayMs > 0)
	{
		std::this_thread::sleep_for(std::chrono::milliseconds(PublicationDelayMs));
	}
	WriteManifest(Manifest, Owner, Nonce, Kind, JobName, Process.dwProcessId, FileTimeValue(Created), "prepared", nullptr);
	const ULONGLONG CommitDeadline = GetTickCount64() + CommitTimeoutMs;
	while (true)
	{
		if (GetTickCount64() >= CommitDeadline)
		{
			if (!TerminateJobObject(Job.get(), ERROR_TIMEOUT))
			{
				throw std::runtime_error("commit deadline expired and owned job termination failed");
			}
			const DWORD ExitCode = ERROR_TIMEOUT;
			WriteManifest(Manifest, Owner, Nonce, Kind, JobName, Process.dwProcessId, FileTimeValue(Created), "aborted", &ExitCode);
			return static_cast<int>(ERROR_TIMEOUT);
		}
		if (ManifestContains(Commit, L"ownerUuid", Owner) && ManifestContains(Commit, L"nonce", Nonce))
		{
			break;
		}
		std::this_thread::sleep_for(std::chrono::milliseconds(10));
	}
	if (ResumeThread(ChildThread.get()) == static_cast<DWORD>(-1))
	{
		TerminateJobObject(Job.get(), ERROR_PROCESS_ABORTED);
		throw std::runtime_error("could not resume owned child");
	}
	WriteManifest(Manifest, Owner, Nonce, Kind, JobName, Process.dwProcessId, FileTimeValue(Created), "running", nullptr);
	WaitForSingleObject(ChildProcess.get(), INFINITE);
	DWORD ExitCode = ERROR_PROCESS_ABORTED;
	GetExitCodeProcess(ChildProcess.get(), &ExitCode);
	WriteManifest(Manifest, Owner, Nonce, Kind, JobName, Process.dwProcessId, FileTimeValue(Created), "exited", &ExitCode);
	return static_cast<int>(ExitCode);
}

bool IsJobEmpty(HANDLE Job)
{
	JOBOBJECT_BASIC_ACCOUNTING_INFORMATION Accounting{};
	if (!QueryInformationJobObject(Job, JobObjectBasicAccountingInformation, &Accounting, sizeof(Accounting), nullptr))
	{
		throw std::runtime_error("owned job accounting query failed");
	}
	return Accounting.ActiveProcesses == 0;
}

int Identity(int argc, wchar_t** argv)
{
	int Separator = 0;
	const auto Options = ParseOptions(argc, argv, 2, Separator);
	const std::wstring& PidText = Require(Options, L"pid");
	const unsigned long PidValue = std::stoul(PidText);
	if (PidValue == 0 || PidValue > MAXDWORD)
	{
		throw std::runtime_error("pid is out of range");
	}
	UniqueHandle Process(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, static_cast<DWORD>(PidValue)));
	if (Process.get() == nullptr)
	{
		return 2;
	}
	FILETIME Created{}, Exited{}, Kernel{}, User{};
	if (!GetProcessTimes(Process.get(), &Created, &Exited, &Kernel, &User) || FileTimeValue(Created) == 0)
	{
		return 3;
	}
	std::cout << "win:" << FileTimeValue(Created);
	return 0;
}

int Query(int argc, wchar_t** argv)
{
	int Separator = 0;
	const auto Options = ParseOptions(argc, argv, 2, Separator);
	const std::wstring& Manifest = Require(Options, L"manifest");
	const std::wstring& Owner = Require(Options, L"owner");
	const std::wstring& Nonce = Require(Options, L"nonce");
	const std::wstring& JobName = Require(Options, L"job-name");
	if (!ManifestContains(Manifest, L"ownerUuid", Owner)
		|| !ManifestContains(Manifest, L"nonce", Nonce)
		|| !ManifestContains(Manifest, L"jobName", JobName))
	{
		throw std::runtime_error("ownership manifest verification failed; refusing job query");
	}
	UniqueHandle Job(OpenJobObjectW(JOB_OBJECT_QUERY, FALSE, JobName.c_str()));
	if (Job.get() == nullptr)
	{
		return GetLastError() == ERROR_FILE_NOT_FOUND ? 0 : 2;
	}
	return IsJobEmpty(Job.get()) ? 0 : 3;
}

int Terminate(int argc, wchar_t** argv)
{
	int Separator = 0;
	const auto Options = ParseOptions(argc, argv, 2, Separator);
	const std::wstring& Manifest = Require(Options, L"manifest");
	const std::wstring& Owner = Require(Options, L"owner");
	const std::wstring& Nonce = Require(Options, L"nonce");
	const std::wstring& JobName = Require(Options, L"job-name");
	const DWORD TimeoutMs = ParseTimeout(Options, L"timeout-ms", 5000);
	if (!ManifestContains(Manifest, L"ownerUuid", Owner)
		|| !ManifestContains(Manifest, L"nonce", Nonce)
		|| !ManifestContains(Manifest, L"jobName", JobName))
	{
		throw std::runtime_error("ownership manifest verification failed; refusing termination");
	}
	UniqueHandle Job(OpenJobObjectW(JOB_OBJECT_TERMINATE | JOB_OBJECT_QUERY | SYNCHRONIZE, FALSE, JobName.c_str()));
	if (Job.get() == nullptr)
	{
		return GetLastError() == ERROR_FILE_NOT_FOUND ? 0 : 2;
	}
	if (!TerminateJobObject(Job.get(), ERROR_PROCESS_ABORTED))
	{
		throw std::runtime_error("owned job termination failed");
	}
	const ULONGLONG Deadline = GetTickCount64() + TimeoutMs;
	while (!IsJobEmpty(Job.get()))
	{
		if (GetTickCount64() >= Deadline)
		{
			return 3;
		}
		std::this_thread::sleep_for(std::chrono::milliseconds(10));
	}
	return 0;
}
}

int wmain(int argc, wchar_t** argv)
{
	try
	{
		if (argc < 2)
		{
			throw std::runtime_error("usage: launch-supervisor launch|terminate|query|identity|durable-replace ...");
		}
		const std::wstring Command = argv[1];
		if (Command == L"launch") return Launch(argc, argv);
		if (Command == L"terminate") return Terminate(argc, argv);
		if (Command == L"query") return Query(argc, argv);
		if (Command == L"identity") return Identity(argc, argv);
		if (Command == L"durable-replace") return DurableReplace(argc, argv);
		throw std::runtime_error("unknown command");
	}
	catch (const std::exception& Error)
	{
		std::cerr << Error.what() << '\n';
		return 1;
	}
}
