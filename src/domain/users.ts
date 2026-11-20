export const USERS = [
  'Priya', 'Arjun', 'Meera', 'Rohan', 'Ananya', 'Vikram', 'Sneha', 'Karan', 'Divya', 'Rahul',
  'Neha', 'Aditya', 'Pooja', 'Sanjay', 'Isha', 'Manish', 'Kavya', 'Nikhil', 'Tara', 'Dev',
] as const

export const userName = (id: number): string => USERS[id] ?? `User ${id}`
