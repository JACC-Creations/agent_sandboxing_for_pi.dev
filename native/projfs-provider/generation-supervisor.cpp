#include <Windows.h>

#include <iostream>
#include <string>
#include <vector>

namespace
{
	std::wstring QuoteArgument(const std::wstring& Value)
	{
		if (!Value.empty() && Value.find_first_of(L" \t\"") == std::wstring::npos)
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
}

int wmain(const int ArgumentCount, wchar_t** Arguments)
{
	if (ArgumentCount < 2)
	{
		std::cerr << "usage: generation-supervisor PROGRAM [ARG...]\n";
		return 2;
	}
	std::wstring CommandLine;
	for (int Index = 1; Index < ArgumentCount; ++Index)
	{
		if (!CommandLine.empty())
		{
			CommandLine.push_back(L' ');
		}
		CommandLine += QuoteArgument(Arguments[Index]);
	}
	std::vector<wchar_t> Writable(CommandLine.begin(), CommandLine.end());
	Writable.push_back(L'\0');
	STARTUPINFOW Startup{};
	Startup.cb = sizeof(Startup);
	Startup.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
	Startup.wShowWindow = SW_HIDE;
	Startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
	Startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
	Startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);
	PROCESS_INFORMATION Process{};
	if (CreateProcessW(Arguments[1], Writable.data(), nullptr, nullptr, TRUE,
		CREATE_UNICODE_ENVIRONMENT | CREATE_NEW_PROCESS_GROUP | DETACHED_PROCESS, nullptr, nullptr, &Startup, &Process) == FALSE)
	{
		std::cerr << "could not start generation monitor: " << GetLastError() << '\n';
		return 3;
	}
	CloseHandle(Process.hThread);
	WaitForSingleObject(Process.hProcess, INFINITE);
	DWORD ExitCode = ERROR_PROCESS_ABORTED;
	GetExitCodeProcess(Process.hProcess, &ExitCode);
	CloseHandle(Process.hProcess);
	return static_cast<int>(ExitCode);
}
