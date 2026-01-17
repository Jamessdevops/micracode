
def calculator(num1, num2, operator):
    if operator == "+":
        return num1 + num2
    elif operator == "-":
        return num1 - num2
    elif operator == "/":
        if num2 != 0:
            return num1 / num2
        else:
            return "Error: Division by zero"
    else:
        return "Error: Invalid operator"

if __name__ == "__main__":
    print("Simple Calculator")
    try:
        n1 = float(input("Enter first number: "))
        op = input("Enter operator (+, -, *, /): "))
        n2 = float(input("Enter second number: "))

        result = calculator(n1, n2, op)
        print(f"Result: {result}")
    except ValueError:
        print("Invalid input. Please enter numbers.")
